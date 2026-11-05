// Shipped's registry on Robinhood Chain and the terms of a BrainChain delivery
// bond on it: a deed with no judge, decided by Shipped's on-chain check reading
// BrainChain's ProofIndex, proofOf(task) >= 1, with the task's poster as the
// refund side.
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

export const proofIndexAbi = parseAbi(["function proofOf(uint256 taskId) view returns (uint256)"]);

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
  "function get(uint256 id) view returns ((address poster, uint128 bounty, uint64 deadline, uint8 status, bool accepted, bool disputed, bool disputedByModel, bytes32 model, bytes32 briefHash, bytes32 resultHash, string briefURI, string resultURI, uint64 submittedAt, uint64 gradedAt, uint64 disputedAt, uint16 gradeThresholdBps, uint16 ruleThresholdBps, uint16 feeBps))",
]);

/** ShippedDeeds.Status and Ruling, as the contract declares them. */
export const DeedStatus = { None: 0, Open: 1, Ruled: 2, Appealed: 3, Settled: 4 } as const;
export const Ruling = { None: 0, Accepted: 1, Rejected: 2, Partial: 3, Invalid: 4, Conceded: 5, Default: 6, CheckMet: 7 } as const;
/** TaskBoard.Status. */
export const TaskStatus = { Open: 1, Hired: 2 } as const;
export const BPS = 10_000n;
export const FEE_BPS = 100n;
/** The bond's deadline is the task's plus this. */
export const BOND_LEAD_SEC = 48n * 3_600n;
export const CHECK_HOLD_SEC = 3_600n;
export const CHECK_CONFIRM_SEC = 86_400n;
/** Under this the fee and the gas take too much of the bond. */
export const MIN_BOND = 2_000_000n;
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

export function encodeCheckData(proofIndex: Address, task: bigint): Hex {
  return encodeAbiParameters(checkDataTypes, [proofIndex, encodeFunctionData({ abi: proofIndexAbi, functionName: "proofOf", args: [task] }), 0, 1n]);
}

/** The task a bond's check reads on `proofIndex`, or undefined for any other check. */
export function taskOfCheck(data: Hex, proofIndex: Address): bigint | undefined {
  try {
    const [target, call, op, threshold] = decodeAbiParameters(checkDataTypes, data);
    if (target.toLowerCase() !== proofIndex.toLowerCase() || op !== 0 || threshold !== 1n) return undefined;
    const { functionName, args } = decodeFunctionData({ abi: proofIndexAbi, data: call });
    return functionName === "proofOf" ? args[0] : undefined;
  } catch {
    return undefined;
  }
}

export function bondTerms(
  config: { check: Address; proofIndex: Address; usdg: Address },
  task: { id: bigint; poster: Address; deadline: bigint },
  board: { address: Address; chainId: number },
): BondTerms {
  return {
    title: `BrainChain task #${task.id}`,
    milestone:
      `The Proof NFT for BrainChain task #${task.id} (task board ${board.address} on BrainChain, chain ${board.chainId}) is recorded in BrainChain's ProofIndex at ${config.proofIndex} on Robinhood Chain, ` +
      `read as proofOf(${task.id}) >= 1. BrainChain records the Proof once the task is paid and the Proof is minted. ` +
      `If no Proof is recorded by the deadline, the bond is paid to the task's poster, ${task.poster}.`,
    project: ZERO,
    projectKind: 0,
    asset: config.usdg,
    deadline: task.deadline + BOND_LEAD_SEC,
    verifier: ZERO,
    backupVerifier: ZERO,
    appealPanel: ZERO,
    check: config.check,
    checkData: encodeCheckData(config.proofIndex, task.id),
    refundTo: task.poster,
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
