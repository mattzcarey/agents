import { describe, expect, it } from "vitest";
import type { ConnectorDescription } from "../connectors";
import type { CodeValidationContext } from "../validation";
import { syntaxValidator } from "../validators/syntax";
import { semanticValidator } from "../validators/semantic";

function connector(
  name: string,
  methods: readonly string[]
): ConnectorDescription {
  const descriptors: ConnectorDescription["descriptors"] = {};
  for (const method of methods) {
    descriptors[method] = { inputSchema: { type: "object" } };
  }
  return { name, descriptors };
}

const CONNECTORS: ConnectorDescription[] = [
  connector("github", [
    "list_issues",
    "get_issue",
    "create_issue",
    "add_comment",
    "list_pull_requests"
  ]),
  connector("slack", ["post_message", "upload_file", "list_channels"]),
  connector("db", ["query", "insert", "update", "transaction"]),
  connector("calendar", ["list_events", "create_event"])
];

const syntax = syntaxValidator();
const semantic = semanticValidator();

async function check(code: string) {
  const context: CodeValidationContext = {
    code,
    normalizedCode: code,
    connectors: CONNECTORS
  };
  const [s, sem] = await Promise.all([
    syntax.validateCode!(context),
    semantic.validateCode!(context)
  ]);
  return {
    syntaxValid: s.valid,
    semantic: sem,
    accepted: s.valid && sem.valid
  };
}

// A large, realistic "triage stale issues and report" program. Exercises:
// nested helper functions, closures, destructuring, Promise.all over connector
// calls, optional chaining, template literals, try/catch, a shadowing local
// named like a connector, and ambient globals (Date, Math, JSON, console).
const TRIAGE_PROGRAM = `async () => {
  const now = Date.now();
  const STALE_MS = 1000 * 60 * 60 * 24 * 30;

  const isStale = (issue) => now - new Date(issue.updated_at).getTime() > STALE_MS;

  const summarize = (items) => {
    const byUser = new Map();
    for (const it of items) {
      const key = it.assignee?.login ?? "unassigned";
      byUser.set(key, (byUser.get(key) ?? 0) + 1);
    }
    return [...byUser.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([user, count]) => \`\${user}: \${count}\`);
  };

  const issues = await github.list_issues({ repo: "agents", state: "open" });
  const stale = issues.filter(isStale);

  await Promise.all(
    stale.map(async (issue) => {
      try {
        await github.add_comment({
          issue: issue.number,
          body: "This issue looks stale. Please update or it will be closed."
        });
      } catch (err) {
        console.warn(\`failed to comment on #\${issue.number}: \${err.message}\`);
      }
    })
  );

  // Local object deliberately shadowing the "slack" connector name.
  const slack = { format: (lines) => lines.join("\\n") };
  const report = slack.format(summarize(stale));

  const channels = await slackClientReport(report);
  await db.insert({
    table: "triage_runs",
    row: { at: now, stale: stale.length, channels }
  });

  return { staleCount: stale.length, report: JSON.parse(JSON.stringify(report)) };

  async function slackClientReport(text) {
    const { channels } = await slack2ChannelList();
    await Promise.all(
      channels.map((c) => globalThis.structuredClone({ c, text }))
    );
    return channels.length;
  }

  async function slack2ChannelList() {
    return { channels: ["#eng", "#triage"] };
  }
}`;

describe("realistic complex programs", () => {
  it("accepts a large multi-connector triage program", async () => {
    const r = await check(TRIAGE_PROGRAM);
    if (!r.accepted) {
      // Surface why, to make a failure actionable.
      console.log("UNEXPECTED REJECTION:", JSON.stringify(r.semantic, null, 2));
    }
    expect(r.syntaxValid).toBe(true);
    expect(r.accepted).toBe(true);
  });

  it("accepts a data-pipeline program with reduce/closures/optional chaining", async () => {
    const code = `async () => {
      const events = await calendar.list_events({ range: "week" });
      const grouped = events.reduce((acc, ev) => {
        const day = new Date(ev.start).toISOString().slice(0, 10);
        (acc[day] ??= []).push(ev.title ?? "(untitled)");
        return acc;
      }, {});
      const rows = Object.entries(grouped).map(([day, titles]) => ({
        day,
        count: titles.length,
        titles
      }));
      await db.transaction(async () => {
        for (const row of rows) {
          await db.insert({ table: "daily", row });
        }
      });
      return rows.length;
    }`;
    const r = await check(code);
    expect(r.accepted).toBe(true);
  });

  it("rejects a large program with one buried unknown method", async () => {
    // Identical shape to a valid program, but calls github.close_issue which
    // is not in the descriptor set.
    const code = `async () => {
      const prs = await github.list_pull_requests({ repo: "agents" });
      const results = [];
      for (const pr of prs) {
        const issue = await github.get_issue({ number: pr.number });
        if (issue.labels?.includes("wontfix")) {
          await github.close_issue({ number: pr.number });
          results.push(pr.number);
        }
      }
      await slack.post_message({ channel: "#eng", text: "done" });
      return results;
    }`;
    const r = await check(code);
    expect(r.syntaxValid).toBe(true);
    expect(r.accepted).toBe(false);
    if (r.semantic.valid) return;
    expect(r.semantic.issues!.some((i) => i.code === "unknown-method")).toBe(
      true
    );
    expect(
      r.semantic.issues!.some((i) => i.message.includes("close_issue"))
    ).toBe(true);
  });

  it("rejects a large program with one buried unknown connector", async () => {
    const code = `async () => {
      const issues = await github.list_issues({ repo: "agents" });
      const summary = issues.map((i) => i.title).join(", ");
      // "jira" is not a configured connector.
      await jira.createTicket({ summary });
      await slack.post_message({ channel: "#eng", text: summary });
      return issues.length;
    }`;
    const r = await check(code);
    expect(r.accepted).toBe(false);
    if (r.semantic.valid) return;
    expect(
      r.semantic.issues!.some(
        (i) => i.code === "unknown-connector" && i.message.includes("jira")
      )
    ).toBe(true);
  });

  it("accepts heavy use of ambient globals and control flow", async () => {
    const code = `async () => {
      const ids = new Set();
      const enc = new TextEncoder();
      const results = await Promise.allSettled(
        [1, 2, 3].map(async (n) => {
          const key = crypto.randomUUID();
          ids.add(key);
          const bytes = enc.encode(String(n));
          return { key, len: bytes.length, ok: Number.isFinite(n) };
        })
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      await db.query({ sql: "select 1", timeout: setTimeout ? 5000 : 0 });
      return { unique: ids.size, ok: ok.length, ts: Date.now() };
    }`;
    const r = await check(code);
    expect(r.accepted).toBe(true);
  });
});
