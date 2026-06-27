import { describe, expect, test } from "bun:test"

import {
    computeDuration,
    extractAgentName,
    formatMs,
    mapStatus,
} from "../src/tui/session-tree.js"

describe("mapStatus", () => {
    test("null/undefined -> idle", () => {
        expect(mapStatus(null)).toBe("idle")
        expect(mapStatus(undefined)).toBe("idle")
    })

    test("busy -> running", () => {
        expect(mapStatus({ type: "busy" })).toBe("running")
    })

    test("retry -> errored", () => {
        expect(mapStatus({ type: "retry" })).toBe("errored")
    })

    test("idle -> idle", () => {
        expect(mapStatus({ type: "idle" })).toBe("idle")
    })

    test("unknown type -> idle", () => {
        expect(mapStatus({ type: "something-else" })).toBe("idle")
    })
})

describe("formatMs", () => {
    test("negative -> empty string", () => {
        expect(formatMs(-1)).toBe("")
        expect(formatMs(-1000)).toBe("")
    })

    test("zero -> 0s", () => {
        expect(formatMs(0)).toBe("0s")
    })

    test("seconds boundary", () => {
        expect(formatMs(5000)).toBe("5s")
        expect(formatMs(59000)).toBe("59s")
    })

    test("minutes boundary", () => {
        expect(formatMs(60000)).toBe("1m")
        expect(formatMs(3540000)).toBe("59m")
    })

    test("hours boundary", () => {
        expect(formatMs(3600000)).toBe("1h0m")
        expect(formatMs(3661000)).toBe("1h1m")
    })

    test("just under 24h still shows hours", () => {
        // 23h exactly: 82800000 ms -> 1380 min -> 23h0m
        expect(formatMs(82800000)).toBe("23h0m")
    })

    test("24h boundary shows days", () => {
        // 24h exactly: 86400000 ms -> 1d0h
        expect(formatMs(86400000)).toBe("1d0h")
    })

    test("more than 24h shows days and remaining hours", () => {
        // 25h: 90000000 ms -> 1d1h
        expect(formatMs(90000000)).toBe("1d1h")
        // 2d5h: (2*24 + 5) * 3600000 = 190800000 ms -> 2d5h
        expect(formatMs(190800000)).toBe("2d5h")
    })
})

describe("extractAgentName", () => {
    test("hyphenated agent name in title (misc-005 regression)", () => {
        expect(extractAgentName([], "@oct-explore subagent")).toBe("oct-explore")
    })

    test("plain agent name in title", () => {
        expect(extractAgentName([], "@explore subagent")).toBe("explore")
    })

    test("prefers agent field from messages over title", () => {
        expect(
            extractAgentName([{ info: { agent: "explore" } }], "@oct-other subagent"),
        ).toBe("explore")
    })

    test("falls back to title when message has no agent field", () => {
        expect(
            extractAgentName([{ info: {} }], "@oct-explore subagent"),
        ).toBe("oct-explore")
    })

    test("CJK agent name from messages is preserved verbatim", () => {
        expect(extractAgentName([{ info: { agent: "探索者" } }], "x")).toBe("探索者")
    })

    test("no agent and no matching title -> task", () => {
        expect(extractAgentName([], "random title")).toBe("task")
    })
})

describe("computeDuration", () => {
    test("empty messages -> empty string", () => {
        expect(computeDuration([])).toBe("")
    })

    test("no created timestamp on first message -> empty string", () => {
        expect(computeDuration([{ info: {} }])).toBe("")
    })

    test("uses completed time of last message", () => {
        const messages = [
            { info: { time: { created: 1000 } } },
            { info: { time: { created: 2000, completed: 5000 } } },
        ]
        // 5000 - 1000 = 4000ms -> 4s
        expect(computeDuration(messages)).toBe("4s")
    })

    test("falls back to created when completed missing on last message", () => {
        const messages = [
            { info: { time: { created: 1000 } } },
            { info: { time: { created: 61000 } } },
        ]
        // 61000 - 1000 = 60000ms -> 1m
        expect(computeDuration(messages)).toBe("1m")
    })
})
