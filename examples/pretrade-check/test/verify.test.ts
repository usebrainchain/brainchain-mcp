import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_DESK } from "../src/desk.ts";
import { checksFor, CHECKS_TEMPLATE, deliveryCode, pretradeCheck, sha256, type GradeRequest } from "../src/request.ts";
import { runLocally, type Run } from "../src/sandbox.ts";
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, numberToHex, parseAbiItem, zeroHash, type Hex } from "viem";

import { cli, verify } from "../src/verify.ts";

import { forgedSignature, MANDATE, MANDATE_FILE, recorded, recordOf, serve, sha512Bypass, tamperRoute } from "./helpers.ts";

const stored = (id: string) => readFileSync(new URL(`../fixtures/records/${id}.json`, import.meta.url));

async function verified(target: string, routes: Record<string, () => Response>) {
  const lines: string[] = [];
  const code = await verify(target, MANDATE_FILE, { fetch: serve(routes), log: (l) => lines.push(l), desk: DEFAULT_DESK });
  const marks = Object.fromEntries(lines.filter((l) => /^ {2}(ok|FAIL|skip) /.test(l)).map((l) => [l.slice(8).split(":")[0], l.slice(2, 6).trim()]));
  return { code, marks, out: lines.join("\n") };
}

const { trade, quote, registry } = recorded("inside");
const request = pretradeCheck({ quote, registry, mandate: MANDATE, trade });
const withBlock = (code: string): GradeRequest => ({ ...request, result: request.result.replace(/```python\n[\s\S]*?\n```/, `\`\`\`python\n${code}\n\`\`\``) });

describe("verify, on records made before the delivery was one string", { timeout: 60_000 }, () => {
  const old = "https://brain.usebrainchain.com/records/0xa37e5f54353e6e93524424bfbacd42d684d01ad748f552183e23ca2f558a504f.json";

  it("reports decision 996 as the earlier form, with its mandate, and runs none of it", async () => {
    const grade = "https://brain.usebrainchain.com/x402/grades/0xe453df0eb113d6e83319d888967a241a7185ca93337c936e2490eceb38106df4";
    const { code, marks, out } = await verified("0xe453df0eb113d6e83319d888967a241a7185ca93337c936e2490eceb38106df4", {
      [grade]: () => Response.json({ grade: "0xe453df0eb113d6e83319d888967a241a7185ca93337c936e2490eceb38106df4", state: "graded", decision: { id: "996", record: `${old}#evidence=0x5ebb6388346b6ecfd394a6504f1aa08325bf2d7bbc3940db508d92a4d0f5dba3` } }),
      [old]: () => new Response(stored("996")),
    });
    expect(code).toBe(2);
    expect(marks).toEqual({ grade: "ok", record: "ok", delivery: "FAIL", checks: "FAIL", mandate: "ok", rerun: "skip" });
    expect(out).toContain("FAIL  delivery: the earlier form, a Python dict; this version vouches only for one base64 string");
    expect(out).toContain(`this version's ${sha256(CHECKS_TEMPLATE)}`);
    expect(out).toContain("Verdict: earlier form.");
    expect(out).toContain("npx brainchain-verify mainnet 996");
  });

  it("reports refused decision 997 as the earlier form, with its delivery withheld and its grade not found", async () => {
    const url = "https://brain.usebrainchain.com/records/0xb9c1ef66decaeb5959b48a41d0c6ab85c11b6fc706c6eefe32e1aad4a47ec5b3.json";
    const { code, marks, out } = await verified(url, { [url]: () => new Response(stored("997")) });
    expect(code).toBe(2);
    expect(marks).toEqual({ grade: "skip", record: "skip", delivery: "skip", checks: "FAIL", mandate: "ok", rerun: "skip" });
    expect(out).toContain("Verdict: earlier form.");
  });
});

describe("verify, on the records of this version's paid runs", { timeout: 60_000 }, () => {
  const graded = (id: string, decision: string) => () => Response.json({ grade: id, state: "graded", decision: { id: decision, record: urls[decision] } });
  const urls: Record<string, string> = {
    "1004": "https://brain.usebrainchain.com/records/0x3541119e6ad75b81b449ea321aa250f7b785a11691e3016edbe66d0742cefff5.json",
    "1005": "https://brain.usebrainchain.com/records/0xdb3407c57ef5ad2d6c573daaf53e2c6bf2e0d8479ce326572b5c32d2f9d9ab8f.json",
  };

  it("matches accepted decision 1004 by its grade id, and runs it again to the same output", async () => {
    const id = "0x6f81a236fa37a14e0733ffd479b5502119a80d8e2a8ddd35250989f6e05e1f11";
    const { code, marks, out } = await verified(id, { [`${DEFAULT_DESK}/x402/grades/${id}`]: graded(id, "1004"), [urls["1004"]!]: () => new Response(stored("1004")) });
    expect(marks).toEqual({ grade: "ok", record: "ok", delivery: "ok", checks: "ok", mandate: "ok", rerun: "ok" });
    expect(out).toContain("ok    checks: an earlier wording of the same rules, kept in src/templates, template SHA-256 40e7241dc56a4a1a0ec76a2b45df444f53af77c934f73f2d194264731625b0b8");
    expect(out).toContain("Verdict: match. The published block is data and nothing else, the checks are an earlier wording of its rules");
    expect(out).toContain("To confirm the record on chain: npx brainchain-verify mainnet 1004");
    expect(code).toBe(0);
  });

  it("cannot verify refused decision 1005, whose delivery is withheld, and says so", async () => {
    const id = "0x4b9d3d432e3f92e4f77e623390defa25991a752695636031b0d220e4761374f3";
    const { code, marks, out } = await verified(urls["1005"]!, { [`${DEFAULT_DESK}/x402/grades/${id}`]: graded(id, "1005"), [urls["1005"]!]: () => new Response(stored("1005")) });
    expect(marks).toEqual({ grade: "ok", record: "skip", delivery: "skip", checks: "ok", mandate: "ok", rerun: "skip" });
    expect(out).toContain("Verdict: not verified.");
    expect(code).toBe(1);
  });
});

describe("verify, given a decision by its id or its page", { timeout: 60_000 }, () => {
  const LOG = "0x2EF509bd9cA1e7C5FBe2C2FD7Ff25cE9F6f9cB68";
  const uri = "https://brain.usebrainchain.com/records/0x3541119e6ad75b81b449ea321aa250f7b785a11691e3016edbe66d0742cefff5.json#evidence=0x5c915944f9920c7ac33b2a16c0e89530efb0c4946d28b6c2b6fe321922bcb116";
  const grade = "0x6f81a236fa37a14e0733ffd479b5502119a80d8e2a8ddd35250989f6e05e1f11";
  const recorded = parseAbiItem("event Recorded(uint256 indexed id, uint8 indexed kind, bytes32 indexed subject, bytes32 inputHash, bytes32 answer, uint16 confidenceBps, bytes32 payloadHash, string payloadURI)");
  const asked: unknown[] = [];
  // BrainChain's chain with one decision on its DecisionLog, 1004.
  const brainchain = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params: { address: string; topics: (Hex | null)[] }[] }) {
        if (method === "eth_chainId") return numberToHex(274663);
        if (method !== "eth_getLogs") throw new Error(method);
        asked.push(params[0]);
        const topics = encodeEventTopics({ abi: [recorded], eventName: "Recorded", args: { id: 1004n, kind: 3, subject: zeroHash } });
        if (params[0]!.topics[1] !== topics[1]) return [];
        const data = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint16" }, { type: "bytes32" }, { type: "string" }], [zeroHash, zeroHash, 9800, "0x3541119e6ad75b81b449ea321aa250f7b785a11691e3016edbe66d0742cefff5", uri]);
        return [{ address: LOG.toLowerCase(), topics, data, blockNumber: "0x400", blockHash: zeroHash, transactionHash: zeroHash, transactionIndex: "0x0", logIndex: "0x0", removed: false }];
      },
    }),
  });
  const routes = {
    [`${DEFAULT_DESK}/network.json`]: () => Response.json({ manifest: { chainId: 274663, activeSet: { fromBlock: 965, contracts: { DecisionLog: LOG } } } }),
    [`${DEFAULT_DESK}/x402/grades/${grade}`]: () => Response.json({ grade, state: "graded", accepted: true, passProbability: 0.98, decision: { id: "1004", record: uri } }),
    [uri.split("#")[0]!]: () => new Response(stored("1004")),
  };
  const run = async (target: string) => {
    const lines: string[] = [];
    const code = await verify(target, MANDATE_FILE, { fetch: serve(routes), log: (l) => lines.push(l), desk: DEFAULT_DESK, brainchain });
    return { code, out: lines.join("\n") };
  };

  it.each(["1004", "https://usebrainchain.com/decision?id=1004"])("reads %s from its Recorded event, as brainchain-verify does", async (target) => {
    const { code, out } = await run(target);
    expect(out).toContain("Decision 1004, grade 0x6f81a236fa37a14e0733ffd479b5502119a80d8e2a8ddd35250989f6e05e1f11: accepted at a pass probability of 98%");
    expect(out).toContain("Verdict: match.");
    expect(code).toBe(0);
    expect(asked.at(-1)).toMatchObject({ address: LOG, fromBlock: numberToHex(965) });
  });

  it("says when the current DecisionLog has no such decision, or the page is of an earlier set", async () => {
    await expect(run("99999")).rejects.toThrow(`DecisionLog ${LOG}, BrainChain's current one, has no decision 99999.`);
    await expect(run("https://usebrainchain.com/decision?id=22&set=v3-1")).rejects.toThrow("A decision page of an earlier contract set is read by its record's URL");
  });
});

describe("verify's command line", () => {
  const run = async (argv: string[]) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await cli(argv, { fetch: serve({}), log: (l) => lines.push(l), error: (l) => errors.push(l), desk: DEFAULT_DESK });
    return { code, out: lines.join("\n"), errors };
  };

  it("says what is missing, and helps on -h", async () => {
    expect(await run(["1004"])).toMatchObject({ code: 1, errors: ["verify needs --mandate <file>: the mandate the decision's checks should carry."] });
    expect(await run(["--mandate", MANDATE_FILE])).toMatchObject({ code: 1, errors: ["verify takes one decision id, decision page, grade id or record URL. See --help."] });
    const help = await run(["-h"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("The target is a decision id such as 1004, its page (https://usebrainchain.com/decision?id=1004), a grade id or a");
  });
});

describe("verify, on records of this version", { timeout: 90_000 }, () => {
  let run: Run;
  beforeAll(async () => {
    run = await runLocally(request);
  }, 60_000);

  it("matches an accepted record, and exits 0", async () => {
    const record = recordOf(request, run);
    const { code, marks, out } = await verified(record.url, record.routes);
    expect(marks).toEqual({ grade: "ok", record: "ok", delivery: "ok", checks: "ok", mandate: "ok", rerun: "ok" });
    expect(out).toContain("rerun: passed here, printing exactly what BrainChain's run printed. Trade: sell 5 USDG for at least 0.003072049707352334 WETH");
    expect(out).toContain("Verdict: match.");
    expect(code).toBe(0);
  });

  it("matches a refused record whose delivery is published, and cannot verify one withheld", async () => {
    const refused = pretradeCheck({ quote: tamperRoute(quote), registry, mandate: MANDATE, trade });
    const failed = await runLocally(refused);
    const shown = recordOf(refused, failed);
    expect((await verified(shown.url, shown.routes)).code).toBe(0);
    const hidden = recordOf(refused, failed, { withheld: true });
    const { code, marks, out } = await verified(hidden.url, hidden.routes);
    expect(marks).toEqual({ grade: "ok", record: "skip", delivery: "skip", checks: "ok", mandate: "ok", rerun: "skip" });
    expect(out).toContain("Verdict: not verified.");
    expect(code).toBe(1);
  });

  // Each attack needs code in the block, and verify refuses the block before anything of it runs here.
  it.each([
    ["the dict subclass", 'class Served(dict):\n    pass\nDELIVERY = Served()'],
    ["the sha512 patch", sha512Bypass(deliveryCode(forgedSignature(tamperRoute(quote)), registry))],
    ["a second statement", `${deliveryCode(quote, registry)}; import os`],
    ["a second line", `${deliveryCode(quote, registry)}\n"".join([])`],
  ])("fails a block holding %s, whatever its run printed", async (_case, block) => {
    const record = recordOf(withBlock(block), run);
    const { code, marks, out } = await verified(record.url, record.routes);
    expect(marks.delivery).toBe("FAIL");
    expect(marks.rerun).toBe("skip");
    expect(out).toContain("Verdict: mismatch on delivery.");
    expect(code).toBe(2);
  });

  it("fails a second Python block, which BrainChain runs too", async () => {
    const twice = { ...request, result: `${request.result}\n\n\`\`\`py\nprint(1)\n\`\`\`` };
    const record = recordOf(twice, run);
    expect((await verified(record.url, record.routes)).out).toContain("FAIL  delivery: the result has 2 Python blocks");
  });

  it("fails checks that carry another mandate or differ from this version's", async () => {
    const elsewhere = { ...request, checks: { language: "python" as const, code: checksFor({ ...MANDATE, maxSlippageBps: 300 }) } };
    const other = recordOf(elsewhere, run);
    const a = await verified(other.url, other.routes);
    expect(a.marks).toMatchObject({ checks: "ok", mandate: "FAIL", rerun: "skip" });
    expect(a.out).toContain("Verdict: mismatch on mandate. The mandate you gave differs from the one these checks carried.");
    const edited = { ...request, checks: { language: "python" as const, code: request.checks.code.replace("_FRESH_SECONDS = 60", "_FRESH_SECONDS = 600") } };
    const changed = recordOf(edited, run);
    const b = await verified(changed.url, changed.routes);
    expect(b.marks).toMatchObject({ checks: "FAIL", mandate: "ok", rerun: "skip" });
    expect(b.code).toBe(2);
  });

  it("fails a record whose run printed what this run does not, or that is not the file its name hashes", async () => {
    const forged = recordOf(request, { ...run, output: run.output.replace("pass  size", "pass  size, and then some") });
    expect((await verified(forged.url, forged.routes)).marks).toMatchObject({ rerun: "FAIL" });
    const record = recordOf(request, run);
    const { marks, code } = await verified(record.url, { ...record.routes, [record.url]: () => new Response(Buffer.concat([record.bytes, Buffer.from(" ")])) });
    expect(marks.record).toBe("FAIL");
    expect(code).toBe(2);
  });

  it("fails a record whose grade's verdict links another record", async () => {
    const record = recordOf(request, run);
    const grade = `${DEFAULT_DESK}/x402/grades/0x${"12".repeat(32)}`;
    const other = { ...record.routes, [grade]: () => Response.json({ grade: `0x${"12".repeat(32)}`, state: "graded", decision: { id: "1", record: `${DEFAULT_DESK}/records/0x${"0".repeat(64)}.json` } }) };
    const { code, marks } = await verified(record.url, other);
    expect(marks.grade).toBe("FAIL");
    expect(code).toBe(2);
  });

  it("reads records only from the desk", async () => {
    await expect(verify("https://evil.test/records/0x00.json", MANDATE_FILE, { fetch: serve({}), log: () => {}, desk: DEFAULT_DESK })).rejects.toThrow("is not a decision record on https://brain.usebrainchain.com");
  });
});
