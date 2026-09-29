// Run with:  node --test agent.test.ts   (Node 22.18+, no dependencies)
import assert from "node:assert/strict";
import test from "node:test";
import agent, { type Answers, decide, textOf } from "./agent.ts";

const answers = (
    tests: Record<string, number>,
    diff: number,
    overclaim: number,
): Answers => ({
    tests: { probabilities: tests },
    diff: { noul: diff },
    overclaim: { noul: overclaim },
});

test("decide: probabilities become a verdict", () => {
    const cases: [string, Answers, string][] = [
        ["all green", answers({ passed: 1 }, 0.96, 0.38), "ACCEPT"],
        ["failing test", answers({ failed: 1 }, 0.9, 0.93), "REJECT"],
        [
            "diff misses the claim",
            answers({ passed: 0.6 }, 0.08, 0.92),
            "REJECT",
        ],
        [
            "tests never run",
            answers({ not_run: 1 }, 0.9, 0.95),
            "NEEDS_EVIDENCE",
        ],
        [
            "claim overreaches",
            answers({ passed: 0.94 }, 0.68, 0.95),
            "NEEDS_EVIDENCE",
        ],
        [
            "unsure tests",
            answers({ passed: 0.6, unrelated: 0.4 }, 0.9, 0.2),
            "NEEDS_EVIDENCE",
        ],
    ];
    for (const [name, input, verdict] of cases) {
        assert.equal(decide(input), verdict, name);
    }
});

test("textOf reads user turns from Responses input and chat messages", () => {
    assert.equal(textOf("plain"), "plain");
    assert.equal(
        textOf([
            { role: "system", content: "ignore" },
            { role: "user", content: [{ type: "input_text", text: "claim" }] },
            { role: "assistant", content: "earlier" },
            { role: "user", content: "diff" },
        ]),
        "claim\ndiff",
    );
});

function run(body: unknown, jev: unknown, status = 200) {
    const seen: { jev?: { path: string; body: any }; settings?: any } = {};
    const request = new Request("https://agent.test/", {
        method: "POST",
        body: JSON.stringify(body),
    });
    return {
        seen,
        result: agent({
            request,
            model: (id) => id as never,
            pollinations: async (path, init) => {
                seen.jev = { path, body: JSON.parse(String(init?.body)) };
                return Response.json(jev, { status });
            },
            respond: async (settings) => {
                seen.settings = settings;
                return new Response("ok", { headers: { "x-keep": "1" } });
            },
        }),
    };
}

test("asks Jev about the report and briefs the model with the verdict", async () => {
    const { seen, result } = run(
        { messages: [{ role: "user", content: "Claim: done. No diff." }] },
        { answers: answers({ not_run: 1 }, 0.4, 0.8) },
    );
    const response = await result;

    assert.equal(seen.jev?.path, "/alpha/decisions");
    assert.equal(seen.jev?.body.state, "Claim: done. No diff.");
    assert.deepEqual(Object.keys(seen.jev?.body.questions), [
        "tests",
        "diff",
        "overclaim",
    ]);
    assert.match(
        seen.settings.instructions,
        /Verdict: NEEDS_EVIDENCE \| tests passed 0%/,
    );
    assert.match(seen.settings.instructions, /no evidence/);
    assert.equal(response.headers.get("x-referee-verdict"), "NEEDS_EVIDENCE");
    assert.equal(response.headers.get("x-keep"), "1");
});

test("surfaces a Jev error instead of guessing a verdict", async () => {
    const { result } = run({ input: "claim" }, { error: "nope" }, 402);
    await assert.rejects(result, /Jev 402/);
});
