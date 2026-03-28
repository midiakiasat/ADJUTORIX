import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / patch_review_panel.test.tsx
 *
 * Canonical patch-review panel renderer contract suite.
 *
 * Purpose:
 * - verify that PatchReviewPanel preserves governed review truth around patch identity,
 *   file-level review state, hunk selection, comments, verify evidence, and apply readiness
 * - verify that review actions remain explicit callback-driven decisions rather than hidden local UI state
 * - verify that empty, degraded, loading, and blocked-review states remain explicit and operator-visible
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible structure, review semantics, and callback routing
 * - prefer per-file/per-hunk review contracts over implementation details
 *
 * Notes:
 * - this suite assumes PatchReviewPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import PatchReviewPanel from "../../../src/renderer/components/PatchReviewPanel";

type PatchReviewPanelProps = React.ComponentProps<typeof PatchReviewPanel>;

function buildProps(overrides: Partial<PatchReviewPanelProps> = {}): PatchReviewPanelProps {
  return {
    title: "Patch review",
    subtitle: "Governed file, hunk, comment, and apply-readiness surface",
    loading: false,
    health: "healthy",
    patchId: "patch-42",
    patchTitle: "Refactor renderer shell composition",
    status: "in-review",
    selectedFileId: "file-1",
    selectedHunkId: "hunk-1",
    files: [
      {
        id: "file-1",
        path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        oldPath: null,
        kind: "modify",
        status: "commented",
        addedLineCount: 24,
        deletedLineCount: 8,
        hunks: [
          {
            id: "hunk-1",
            header: "@@ -20,8 +20,15 @@",
            oldRange: { startLine: 20, endLine: 28 },
            newRange: { startLine: 20, endLine: 35 },
            lines: [],
          },
          {
            id: "hunk-2",
            header: "@@ -80,6 +87,14 @@",
            oldRange: { startLine: 80, endLine: 86 },
            newRange: { startLine: 87, endLine: 101 },
            lines: [],
          },
        ],
        comments: [
          {
            id: "comment-1",
            author: "reviewer",
            body: "This branch preserves shell intent, but the status badge grouping needs clarification.",
            createdAtMs: 1711000000000,
            status: "open",
            filePath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
            hunkId: "hunk-1",
          },
        ],
      },
      {
        id: "file-2",
        path: "/repo/adjutorix-app/src/renderer/components/ProviderStatus.tsx",
        oldPath: null,
        kind: "modify",
        status: "accepted",
        addedLineCount: 6,
        deletedLineCount: 2,
        hunks: [
          {
            id: "hunk-3",
            header: "@@ -1,3 +1,7 @@",
            oldRange: { startLine: 1, endLine: 3 },
            newRange: { startLine: 1, endLine: 7 },
            lines: [],
          },
        ],
        comments: [],
      },
      {
        id: "file-3",
        path: "/repo/adjutorix-app/src/renderer/components/DiagnosticsPanel.tsx",
        oldPath: null,
        kind: "modify",
        status: "rejected",
        addedLineCount: 3,
        deletedLineCount: 5,
        hunks: [
          {
            id: "hunk-4",
            header: "@@ -55,9 +55,7 @@",
            oldRange: { startLine: 55, endLine: 64 },
            newRange: { startLine: 55, endLine: 62 },
            lines: [],
          },
        ],
        comments: [
          {
            id: "comment-2",
            author: "lead-reviewer",
            body: "Rejected until severity grouping is normalized consistently with diagnostic_parser output.",
            createdAtMs: 1711000001000,
            status: "open",
            filePath: "/repo/adjutorix-app/src/renderer/components/DiagnosticsPanel.tsx",
            hunkId: "hunk-4",
          },
        ],
      },
    ],
    comments: [
      {
        id: "comment-global-1",
        author: "architect",
        body: "Apply gate remains blocked until rejected files are resolved.",
        createdAtMs: 1711000002000,
        status: "open",
        filePath: null,
        hunkId: null,
      },
    ],
    verifyEvidence: [
      {
        verifyId: "verify-9",
        status: "passed",
        summary: "Renderer contracts passed in local verify run.",
        updatedAtMs: 1711000003000,
      },
      {
        verifyId: "verify-10",
        status: "partial",
        summary: "Smoke suite pending due to rejected diagnostics panel changes.",
        updatedAtMs: 1711000004000,
      },
    ],
    applyReadiness: "blocked",
    metrics: {
      totalFiles: 3,
      totalHunks: 4,
      totalComments: 3,
      acceptedFiles: 1,
      rejectedFiles: 1,
      commentedFiles: 1,
    },
    canApproveFile: true,
    canRejectFile: true,
    canComment: true,
    canApply: false,
    canRefresh: true,
    onSelectFile: vi.fn(),
    onSelectHunk: vi.fn(),
    onApproveFile: vi.fn(),
    onRejectFile: vi.fn(),
    onOpenCommentComposer: vi.fn(),
    onApplyRequested: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as PatchReviewPanelProps;
}

describe("PatchReviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical review shell with title, subtitle, patch identity, and file list", () => {
    render(<PatchReviewPanel {...buildProps()} />);

    expect(screen.getByText(/Patch review/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed file, hunk, comment, and apply-readiness surface/i)).toBeInTheDocument();
    expect(screen.getByText(/patch-42/i)).toBeInTheDocument();
    expect(screen.getByText(/Refactor renderer shell composition/i)).toBeInTheDocument();
    expect(screen.getByText(/AppShell\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText(/ProviderStatus\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText(/DiagnosticsPanel\.tsx/i)).toBeInTheDocument();
  });

  it("surfaces file-level review status explicitly so accepted, commented, and rejected files remain distinct", () => {
    render(<PatchReviewPanel {...buildProps()} />);

    expect(screen.getByText(/commented/i)).toBeInTheDocument();
    expect(screen.getByText(/accepted/i)).toBeInTheDocument();
    expect(screen.getByText(/rejected/i)).toBeInTheDocument();
  });

  it("preserves hunk identity and headers explicitly instead of hiding review focus inside a diff surface only", () => {
    render(<PatchReviewPanel {...buildProps()} />);

    expect(screen.getByText(/@@ -20,8 \+20,15 @@/i)).toBeInTheDocument();
    expect(screen.getByText(/@@ -80,6 \+87,14 @@/i)).toBeInTheDocument();
    expect(screen.getByText(/@@ -55,9 \+55,7 @@/i)).toBeInTheDocument();
  });

  it("surfaces per-file and global comments explicitly as review evidence", () => {
    render(<PatchReviewPanel {...buildProps()} />);

    expect(screen.getByText(/status badge grouping needs clarification/i)).toBeInTheDocument();
    expect(screen.getByText(/Apply gate remains blocked until rejected files are resolved/i)).toBeInTheDocument();
  });

  it("surfaces verify evidence explicitly so review and verification do not drift apart", () => {
    render(<PatchReviewPanel {...buildProps()} />);

    expect(screen.getByText(/verify-9/i)).toBeInTheDocument();
    expect(screen.getByText(/Renderer contracts passed in local verify run/i)).toBeInTheDocument();
    expect(screen.getByText(/verify-10/i)).toBeInTheDocument();
    expect(screen.getByText(/Smoke suite pending/i)).toBeInTheDocument();
  });

  it("surfaces apply-readiness posture explicitly instead of implying the patch is safe to apply", () => {
    render(<PatchReviewPanel {...buildProps()} />);

    expect(screen.getByText(/blocked/i)).toBeInTheDocument();
  });

  it("wires file selection to the explicit callback instead of silently mutating local review focus", () => {
    const props = buildProps();
    render(<PatchReviewPanel {...props} />);

    fireEvent.click(screen.getByText(/ProviderStatus\.tsx/i));

    expect(props.onSelectFile).toHaveBeenCalledTimes(1);
    expect(props.onSelectFile).toHaveBeenCalledWith("file-2");
  });

  it("wires hunk selection to the explicit callback", () => {
    const props = buildProps();
    render(<PatchReviewPanel {...props} />);

    fireEvent.click(screen.getByText(/@@ -80,6 \+87,14 @@/i));

    expect(props.onSelectHunk).toHaveBeenCalledTimes(1);
    expect(props.onSelectHunk).toHaveBeenCalledWith("hunk-2");
  });

  it("wires approve and reject actions explicitly for per-file decisions", () => {
    const props = buildProps();
    render(<PatchReviewPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const approveButton = buttons.find((button) => /approve/i.test(button.textContent ?? ""));
    const rejectButton = buttons.find((button) => /reject/i.test(button.textContent ?? ""));

    expect(approveButton).toBeDefined();
    expect(rejectButton).toBeDefined();

    fireEvent.click(approveButton!);
    fireEvent.click(rejectButton!);

    expect(props.onApproveFile).toHaveBeenCalled();
    expect(props.onRejectFile).toHaveBeenCalled();
  });

  it("wires comment composer, apply, and refresh actions explicitly", () => {
    const props = buildProps();
    render(<PatchReviewPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const commentButton = buttons.find((button) => /comment/i.test(button.textContent ?? ""));
    const applyButton = buttons.find((button) => /apply/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(commentButton).toBeDefined();
    expect(applyButton).toBeDefined();
    expect(refreshButton).toBeDefined();

    fireEvent.click(commentButton!);
    fireEvent.click(applyButton!);
    fireEvent.click(refreshButton!);

    expect(props.onOpenCommentComposer).toHaveBeenCalledTimes(1);
    expect(props.onApplyRequested).toHaveBeenCalledTimes(1);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("does not advertise apply as enabled when apply readiness is blocked", () => {
    render(
      <PatchReviewPanel
        {...buildProps({
          canApply: false,
          applyReadiness: "blocked",
        })}
      />,
    );

    const applyButton = screen.getAllByRole("button").find((button) => /apply/i.test(button.textContent ?? ""));
    expect(applyButton).toBeDisabled();
  });

  it("surfaces degraded health posture explicitly instead of assuming review freshness", () => {
    render(
      <PatchReviewPanel
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("supports empty review posture explicitly when no files are present", () => {
    render(
      <PatchReviewPanel
        {...buildProps({
          files: [],
          comments: [],
          verifyEvidence: [],
          selectedFileId: null,
          selectedHunkId: null,
          applyReadiness: "unknown",
          metrics: {
            totalFiles: 0,
            totalHunks: 0,
            totalComments: 0,
            acceptedFiles: 0,
            rejectedFiles: 0,
            commentedFiles: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/Patch review/i)).toBeInTheDocument();
    expect(screen.queryByText(/AppShell\.tsx/i)).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the review shell contract", () => {
    render(
      <PatchReviewPanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Patch review/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed file, hunk, comment, and apply-readiness surface/i)).toBeInTheDocument();
  });

  it("keeps metrics operator-visible as facts about total files, hunks, comments, and decisions", () => {
    render(<PatchReviewPanel {...buildProps()} />);

    expect(screen.getByText(/total/i)).toBeInTheDocument();
    expect(screen.getByText(/hunks/i)).toBeInTheDocument();
    expect(screen.getByText(/comments/i)).toBeInTheDocument();
    expect(screen.getByText(/accepted/i)).toBeInTheDocument();
    expect(screen.getByText(/rejected/i)).toBeInTheDocument();
  });

  it("preserves per-file path identity and does not flatten all review items into generic names", () => {
    render(<PatchReviewPanel {...buildProps()} />);

    expect(screen.getByText(/\/repo\/adjutorix-app\/src\/renderer\/components\/AppShell\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/adjutorix-app\/src\/renderer\/components\/ProviderStatus\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/adjutorix-app\/src\/renderer\/components\/DiagnosticsPanel\.tsx/i)).toBeInTheDocument();
  });

  it("does not collapse the review shell into only a file list; comments, verify evidence, and controls remain distinct surfaces", () => {
    render(<PatchReviewPanel {...buildProps()} />);

    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/verify-9/i)).toBeInTheDocument();
    expect(screen.getByText(/status badge grouping needs clarification/i)).toBeInTheDocument();
    expect(screen.getByText(/@@ -20,8 \+20,15 @@/i)).toBeInTheDocument();
  });

  it("supports a ready-to-apply posture explicitly when all review blockers are cleared", () => {
    render(
      <PatchReviewPanel
        {...buildProps({
          status: "approved",
          applyReadiness: "ready",
          canApply: true,
          files: buildProps().files.map((file) => ({
            ...file,
            status: file.id === "file-3" ? "accepted" : file.status,
          })),
          metrics: {
            totalFiles: 3,
            totalHunks: 4,
            totalComments: 3,
            acceptedFiles: 2,
            rejectedFiles: 0,
            commentedFiles: 1,
          },
        })}
      />,
    );

    expect(screen.getByText(/approved/i)).toBeInTheDocument();
    expect(screen.getByText(/ready/i)).toBeInTheDocument();

    const applyButton = screen.getAllByRole("button").find((button) => /apply/i.test(button.textContent ?? ""));
    expect(applyButton).not.toBeDisabled();
  });
});
