import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import type { ScanFinding } from "../src/types";

// Mock @actions/core
vi.mock("@actions/core", () => ({
  error: vi.fn(),
  warning: vi.fn(),
  notice: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  getInput: vi.fn(),
  summary: {
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn(),
  },
}));

// Mock @actions/github
const mockCreateReview = vi.fn();
const mockListComments = vi.fn().mockResolvedValue({ data: [] });
const mockCreateComment = vi.fn();
const mockUpdateComment = vi.fn();

vi.mock("@actions/github", () => ({
  context: {
    payload: {
      pull_request: {
        number: 42,
        head: { sha: "abc123" },
        base: { sha: "def456" },
      },
    },
    repo: { owner: "test-owner", repo: "test-repo" },
  },
  getOctokit: vi.fn(() => ({
    rest: {
      pulls: { createReview: mockCreateReview },
      issues: {
        listComments: mockListComments,
        createComment: mockCreateComment,
        updateComment: mockUpdateComment,
      },
    },
  })),
}));

function makeFinding(overrides: Partial<ScanFinding> = {}): ScanFinding {
  return {
    ruleId: "HIPAA-164.312-a1",
    controlId: "164.312(a)(1)",
    severity: "high",
    confidence: "high",
    engine: "prodcycle",
    framework: "hipaa",
    resourceType: "code",
    resourcePath: "src/auth.ts",
    resourceName: "authenticateUser",
    startLine: 10,
    endLine: 15,
    message: "Missing encryption for data at rest",
    remediation: "Use AES-256 encryption for stored credentials",
    ...overrides,
  };
}

describe("annotate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(core.getInput).mockReturnValue("fake-token");
  });

  describe("createAnnotations", () => {
    it("creates error annotations for critical/high findings with line numbers", async () => {
      const { createAnnotations } = await import("../src/annotate");

      const findings = [makeFinding({ severity: "critical", startLine: 5, endLine: 10 })];
      createAnnotations(findings);

      expect(core.error).toHaveBeenCalledOnce();
      const call = vi.mocked(core.error).mock.calls[0];
      expect(call[1]).toMatchObject({
        file: "src/auth.ts",
        startLine: 5,
        endLine: 10,
      });
    });

    it("creates warning annotations for medium findings", async () => {
      const { createAnnotations } = await import("../src/annotate");

      createAnnotations([makeFinding({ severity: "medium" })]);
      expect(core.warning).toHaveBeenCalledOnce();
    });

    it("creates notice annotations for low findings", async () => {
      const { createAnnotations } = await import("../src/annotate");

      createAnnotations([makeFinding({ severity: "low" })]);
      expect(core.notice).toHaveBeenCalledOnce();
    });
  });

  describe("postReviewComments", () => {
    it("posts a PR review with inline comments for findings with line info", async () => {
      const { postReviewComments } = await import("../src/annotate");

      const findings = [
        makeFinding({ startLine: 10, endLine: 15 }),
        makeFinding({
          ruleId: "SOC2-CC6.1",
          severity: "medium",
          resourcePath: "src/db.ts",
          startLine: 20,
          endLine: 20,
          message: "Unencrypted database connection",
        }),
      ];

      mockCreateReview.mockResolvedValue({ data: {} });
      await postReviewComments(findings, false);

      expect(mockCreateReview).toHaveBeenCalledOnce();
      const call = mockCreateReview.mock.calls[0][0];

      expect(call.owner).toBe("test-owner");
      expect(call.repo).toBe("test-repo");
      expect(call.pull_number).toBe(42);
      expect(call.commit_id).toBe("abc123");
      expect(call.event).toBe("REQUEST_CHANGES");
      expect(call.comments).toHaveLength(2);

      // First comment: multi-line (startLine < endLine)
      expect(call.comments[0].path).toBe("src/auth.ts");
      expect(call.comments[0].line).toBe(15);
      expect(call.comments[0].start_line).toBe(10);

      // Second comment: single line (startLine === endLine)
      expect(call.comments[1].path).toBe("src/db.ts");
      expect(call.comments[1].line).toBe(20);
      expect(call.comments[1].start_line).toBeUndefined();
    });

    it("uses COMMENT event when scan passed", async () => {
      const { postReviewComments } = await import("../src/annotate");

      mockCreateReview.mockResolvedValue({ data: {} });
      await postReviewComments([makeFinding()], true);

      expect(mockCreateReview.mock.calls[0][0].event).toBe("COMMENT");
    });

    it("skips findings without line information", async () => {
      const { postReviewComments } = await import("../src/annotate");

      const findings = [makeFinding({ startLine: 0, endLine: 0 })];
      mockCreateReview.mockResolvedValue({ data: {} });
      await postReviewComments(findings, false);

      expect(mockCreateReview).not.toHaveBeenCalled();
    });

    it("skips findings where endLine is 0 even if startLine is set", async () => {
      const { postReviewComments } = await import("../src/annotate");

      const findings = [makeFinding({ startLine: 5, endLine: 0 })];
      mockCreateReview.mockResolvedValue({ data: {} });
      await postReviewComments(findings, false);

      expect(mockCreateReview).not.toHaveBeenCalled();
    });

    it("skips when no github token is available", async () => {
      const { postReviewComments } = await import("../src/annotate");

      vi.mocked(core.getInput).mockReturnValue("");
      delete process.env.GITHUB_TOKEN;

      await postReviewComments([makeFinding()], false);
      expect(mockCreateReview).not.toHaveBeenCalled();
    });

    it("warns but does not throw when review creation fails", async () => {
      const { postReviewComments } = await import("../src/annotate");

      mockCreateReview.mockRejectedValue(new Error("Validation Failed"));
      await postReviewComments([makeFinding()], false);

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to post PR review"),
      );
    });

    it("includes severity icon and remediation in comment body", async () => {
      const { postReviewComments } = await import("../src/annotate");

      mockCreateReview.mockResolvedValue({ data: {} });
      await postReviewComments([makeFinding({ severity: "critical" })], false);

      const body = mockCreateReview.mock.calls[0][0].comments[0].body;
      expect(body).toContain("🔴");
      expect(body).toContain("[CRITICAL]");
      expect(body).toContain("Remediation:");
      expect(body).toContain("AES-256");
    });
  });
});
