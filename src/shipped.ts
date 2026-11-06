// Shipped's registry on Robinhood Chain and the terms of a BrainChain delivery
// bond on it: a deed with no judge, decided by Shipped's on-chain check reading
// BrainChain's ProofIndex, proofOf(task) >= 1, with the agent that paid for the
// task as the refund side.
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

export const proofIndexAbi = parseAbi(["function proofOf(address board, uint256 taskId) view returns (uint256)"]);

const TERMS =
  "(string title, string milestone, address project, uint8 projectKind, address asset, uint64 deadline, address verifier, address backupVerifier, address appealPanel, address check, bytes checkData, address refundTo, uint16 defaultRemainderBps, uint16 refundCapBps, bool allowPartial, uint32 verifierGrace, uint32 backupGrace, uint32 appealWindow, uint32 panelWindow, uint128 appealBond, uint128 verifierFee, address[] refundExcluded)";

export const shippedAbi = parseAbi([
  `function create(${TERMS} t, uint256 deposit) returns (uint256 deedId)`,
  "function withdraw(address asset) returns (uint256)",
  "function owed(address account, address asset) view returns (uint256)",
  "function deedCount() view returns (uint256)",
  "function core(uint256 deedId) view returns (address creator, uint8 status, address asset, uint64 deadline)",
  `function getDeed(uint256 deedId) view returns ((address creator, uint8 status, uint8 ruling, uint16 remainderBps, uint16 feeBps, bool overturned, uint64 createdAt, uint64 ruledAt, uint64 appealedAt, uint64 settledAt, uint64 checkMetAt, uint64 windowEnd, address ruledBy, address appellant, uint256 balance, ${TERMS} terms))`,
  `event DeedCreated(uint256 indexed deedId, address indexed creator, address indexed project, ${TERMS} terms, uint256 deposit, uint16 feeBps)`,
]);

export const taskBoardAbi = parseAbi([
  // TaskBoard.get as deployed in sets 3.4.0 and 3.5.0; the brief and result live off chain behind their hashes.
  "function get(uint256 id) view returns ((address poster, uint128 bounty, uint64 deadline, uint8 status, bool accepted, bool disputed, bool disputedByModel, bytes32 model, bytes32 briefHash, bytes32 resultHash, uint64 submittedAt, uint64 gradedAt, uint64 disputedAt, uint64 postedAt, address payee, address feeRecipient, uint16 feeBps, uint16 hireThresholdBps, uint16 gradeThresholdBps, uint16 ruleThresholdBps, uint64 gradeWindow, uint64 disputeWindow, uint64 ruleWindow))",
]);

/** ShippedDeeds.Status and Ruling, as the contract declares them. */
export const DeedStatus = { None: 0, Open: 1, Ruled: 2, Appealed: 3, Settled: 4 } as const;
export const Ruling = { None: 0, Accepted: 1, Rejected: 2, Partial: 3, Invalid: 4, Conceded: 5, Default: 6, CheckMet: 7 } as const;
/** TaskBoard.Status. */
export const TaskStatus = { Open: 1, Hired: 2, Paid: 6, Refunded: 7 } as const;
export const BPS = 10_000n;
export const FEE_BPS = 100n;
/** The bond's deadline is the task's plus this: 48 hours for a grade, a dispute and an appealed ruling on set 3.5.0, then the worker's day to mint. */
export const BOND_LEAD_SEC = 72n * 3_600n;
export const CHECK_HOLD_SEC = 3_600n;
export const CHECK_CONFIRM_SEC = 86_400n;
/** Under this the fee and the gas take too much of the bond. */
export const MIN_BOND = 2_000_000n;
/** Who a missed bond pays, in the same words wherever a tool says it. A bond names the address, not which of the two it is. */
export const MISSED_TO = "the agent that paid BrainChain's desk for the task, or to the poster for a task posted on the board directly";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

export interface BondTerms {
  title: string;
  milestone: string;
  project: Address;
  projectKind: number;
  asset: Address;
  deadline: bigint;
  verifier: Address;
  backupVerifier: Address;
  appealPanel: Address;
  check: Address;
  checkData: Hex;
  refundTo: Address;
  defaultRemainderBps: number;
  refundCapBps: number;
  allowPartial: boolean;
  verifierGrace: number;
  backupGrace: number;
  appealWindow: number;
  panelWindow: number;
  appealBond: bigint;
  verifierFee: bigint;
  refundExcluded: Address[];
}

const checkDataTypes = [{ type: "address" }, { type: "bytes" }, { type: "uint8" }, { type: "uint256" }] as const;

/** Task ids restart with each board, so the board is part of the key. */
export function encodeCheckData(proofIndex: Address, board: Address, task: bigint): Hex {
  return encodeAbiParameters(checkDataTypes, [proofIndex, encodeFunctionData({ abi: proofIndexAbi, functionName: "proofOf", args: [board, task] }), 0, 1n]);
}

/** The task a bond's check reads on `proofIndex` for `board`, or undefined for any other check. */
export function taskOfCheck(data: Hex, proofIndex: Address, board: Address): bigint | undefined {
  try {
    const [target, call, op, threshold] = decodeAbiParameters(checkDataTypes, data);
    if (target.toLowerCase() !== proofIndex.toLowerCase() || op !== 0 || threshold !== 1n) return undefined;
    const { functionName, args } = decodeFunctionData({ abi: proofIndexAbi, data: call });
    return functionName === "proofOf" && args[0].toLowerCase() === board.toLowerCase() ? args[1] : undefined;
  } catch {
    return undefined;
  }
}

/** The refund side is the agent that paid for the task: the poster on the board, or the payer the desk recorded. */
export function bondTerms(
  config: { check: Address; proofIndex: Address; usdg: Address },
  task: { id: bigint; refundTo: Address; paidThroughDesk: boolean; deadline: bigint },
  board: { address: Address; chainId: number },
): BondTerms {
  return {
    title: `BrainChain task #${task.id}`,
    milestone:
      `The Proof NFT for BrainChain task #${task.id} (task board ${board.address} on BrainChain, chain ${board.chainId}) is recorded in BrainChain's ProofIndex at ${config.proofIndex} on Robinhood Chain, ` +
      `read as proofOf(${board.address}, ${task.id}) >= 1. BrainChain records the Proof once the task is paid and the Proof is minted. ` +
      `If no Proof is recorded by the deadline, the bond is paid to ${task.refundTo}, ${task.paidThroughDesk ? "the agent that paid BrainChain's desk for the task" : "the task's poster"}.`,
    project: ZERO,
    projectKind: 0,
    asset: config.usdg,
    deadline: task.deadline + BOND_LEAD_SEC,
    verifier: ZERO,
    backupVerifier: ZERO,
    appealPanel: ZERO,
    check: config.check,
    checkData: encodeCheckData(config.proofIndex, board.address, task.id),
    refundTo: task.refundTo,
    defaultRemainderBps: 0,
    refundCapBps: 0,
    allowPartial: false,
    verifierGrace: 0,
    backupGrace: 0,
    appealWindow: 0,
    panelWindow: 0,
    appealBond: 0n,
    verifierFee: 0n,
    refundExcluded: [],
  };
}
