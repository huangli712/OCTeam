/**
 * Member name allocation. A name is drawn at random from a fixed pool and not
 * reused within the same team. Co-located with the state layer so the naming
 * policy is reusable independent of the tool definitions.
 */

/**
 * Candidate name pool for members whose name is omitted at creation. A name is
 * drawn at random and not reused within the same team. The pool (32) exceeds the
 * 12-member team cap, so it never runs out for a single team.
 */
export const MEMBER_NAME_POOL = [
    "alice", "bob", "carol", "dave", "erin", "frank", "grace", "henry",
    "iris", "jack", "kate", "leo", "mona", "nina", "omar", "pat",
    "quinn", "ruby", "sam", "tom", "uma", "victor", "wendy", "xander",
    "yara", "zane", "ava", "ben", "chloe", "dan", "ella", "finn",
] as const

/** Reserved synthetic identity: the leader pseudo-member. */
export const MASTER_NAME = "master" as const

/** Reserved synthetic identity: the orchestrator message sender. */
export const ORCHESTRATOR_NAME = "orchestrator" as const

/** All reserved names that cannot be used as member names. */
export const RESERVED_NAMES = [MASTER_NAME, ORCHESTRATOR_NAME] as const

/**
 * Pick a random name from MEMBER_NAME_POOL not present in `taken`. Falls back to
 * "member-N" (N = taken.size + 1) if every pool name is already taken.
 */
export function pickName(taken: Set<string>): string {
    const available = MEMBER_NAME_POOL.filter(n => !taken.has(n))
    if (available.length === 0) return `member-${taken.size + 1}`
    return available[Math.floor(Math.random() * available.length)]
}
