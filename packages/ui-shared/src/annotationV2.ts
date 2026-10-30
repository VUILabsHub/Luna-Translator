import {
  apiFetch,
  createApiTraceContext,
  type ApiTraceContext,
} from "./lib/apiFetch";
import { joinTranscriptFragment } from "./lib/transcript";

export type AnnotationUser = {
  id: string;
  normalizedEmail: string;
  emailVerified: boolean;
  role: "annotator" | "dataset_admin" | "data_owner" | "suspended";
  // Owner-managed onboarding stage from /me: "formal" = 正式, empty/absent =
  // 候选人. Only populated by annotationMe (not the login responses).
  membershipStatus?: string;
};
export type DatasetStats = {
  taskCount: number;
  assignmentCount: number;
  pendingCount: number;
  inProgressCount: number;
  completedCount: number;
  singleCompletedTaskCount: number;
  crossCompletedTaskCount: number;
  sourceCounts: Record<string, number>;
};
export type Dataset = {
  id: string;
  name: string;
  description?: string;
  version: number;
  status: string;
  sourceLanguage: string;
  defaultAnnotatorsPerTask: number;
  memberRole: string;
  stats: DatasetStats;
  createdAt: string;
  updatedAt: string;
};
export type DatasetMemberRole = "owner" | "admin" | "annotator" | "viewer" | "reviewer";
export type DatasetMember = {
  datasetId: string;
  userId: string;
  workEmail: string;
  role: DatasetMemberRole;
  addedBy: string;
  createdAt: string;
};
export type SourceSegment = {
  id: string;
  sequence: number;
  startMs: number;
  endMs: number;
  asrText: string;
  timestampSource: string;
};
export type Task = {
  scene?: string;
  sourceLanguage?: string;
  id: string;
  datasetId: string;
  sampleName: string;
  source: { kind: string; provider?: string; model?: string; audioSha256?: string; referencesSha256?: string };
  audioUrl: string;
  audioContentType?: string;
  audioId: string;
  durationMs: number;
  segments: SourceSegment[];
  requiredAnnotatorCount: number;
  status?: "open" | "closed" | "retired";
  batchId?: string;
  batchName?: string;
  allocationPaused?: boolean;
  duplicateOf?: { datasetId: string; taskId: string };
  assignments?: Assignment[];
  completedCount?: number;
  acceptedCount?: number;
  pendingAcceptanceCount?: number;
  rejectedCount?: number;
  acceptanceState?: "waiting_completion" | "pending_acceptance" | "accepted";
};
export type Assignment = {
  id: string;
  datasetId: string;
  taskId: string;
  annotatorId: string;
  status: "pending" | "in_progress" | "completed";
  assignedAt: string;
};
export type SegmentAnnotation = {
  segmentId: string;
  sourceSegmentId?: string;
  sourceSegmentIds?: string[];
  sequence: number;
  startMs: number;
  endMs: number;
  originalAsrText: string;
  annotatedText: string;
  state:
    | "unreviewed"
    | "asr_unchanged"
    | "human_edited"
    | "human_filled"
    | "still_empty";
  reviewed: boolean;
  reviewedAt?: string;
  firstEditedAt?: string;
  updatedAt: string;
  qualityFingerprint?: string;
  qualityStatus?: "passed" | "failed";
  qualitySentenceCount?: number;
  qualityReason?: string;
  qualityCheckedAt?: string;
  qualityPassedAt?: string;
  qualityDisputeFingerprint?: string;
  qualityDisputedAt?: string;
};

export type AnnotationQualityIssue = {
  segmentId: string;
  sequence: number;
  sentenceCount: number;
  reason: string;
};

const annotationQualityInput = (annotation: SegmentAnnotation) => {
  const {
    qualityFingerprint: _qualityFingerprint,
    qualityStatus: _qualityStatus,
    qualitySentenceCount: _qualitySentenceCount,
    qualityReason: _qualityReason,
    qualityCheckedAt: _qualityCheckedAt,
    qualityPassedAt: _qualityPassedAt,
    qualityDisputeFingerprint: _qualityDisputeFingerprint,
    qualityDisputedAt: _qualityDisputedAt,
    ...input
  } = annotation;
  return input;
};

export const invalidateChangedAnnotationQuality = (
  previous: SegmentAnnotation,
  next: SegmentAnnotation,
): SegmentAnnotation => {
  if (
    JSON.stringify(annotationQualityInput(previous)) ===
    JSON.stringify(annotationQualityInput(next))
  ) return next;
  const {
    qualityFingerprint: _qualityFingerprint,
    qualityStatus: _qualityStatus,
    qualitySentenceCount: _qualitySentenceCount,
    qualityReason: _qualityReason,
    qualityCheckedAt: _qualityCheckedAt,
    qualityPassedAt: _qualityPassedAt,
    qualityDisputeFingerprint: _qualityDisputeFingerprint,
    qualityDisputedAt: _qualityDisputedAt,
    ...withoutQuality
  } = next;
  return withoutQuality;
};

export const annotationQualitySolution = (sentenceCount = 0) =>
  sentenceCount > 1
    ? `建议：使用“AI 拆句”，或在播放头定位语义边界后拆成 ${sentenceCount} 个独立片段；只修改标点不会解决语义多句问题。`
    : "建议：复核片段文字和时间边界；如确认 AI 判断错误，可标记“AI质检有问题”后继续完成任务。";

export const retainUnchangedAnnotationIssueIds = (
  issueIds: string[],
  previous: SegmentAnnotation[],
  next: SegmentAnnotation[],
) => {
  const previousById = new Map(previous.map((annotation) => [annotation.segmentId, annotation]));
  const nextById = new Map(next.map((annotation) => [annotation.segmentId, annotation]));
  return issueIds.filter((segmentId) => {
    const previousAnnotation = previousById.get(segmentId);
    const nextAnnotation = nextById.get(segmentId);
    return Boolean(
      previousAnnotation &&
      nextAnnotation &&
      !nextAnnotation.qualityDisputedAt &&
      JSON.stringify(annotationQualityInput(previousAnnotation)) ===
        JSON.stringify(annotationQualityInput(nextAnnotation)),
    );
  });
};

export const annotationSourceSegmentIds = (annotation: SegmentAnnotation) =>
  annotation.sourceSegmentIds !== undefined
    ? annotation.sourceSegmentIds
    : annotation.sourceSegmentId
      ? [annotation.sourceSegmentId]
      : [annotation.segmentId];

export const renumberSegmentAnnotations = (annotations: SegmentAnnotation[]) =>
  annotations.map((annotation, index) => ({
    ...annotation,
    sequence: index + 1,
  }));

export const annotationOverlapSegmentIds = (
  annotations: SegmentAnnotation[],
) => {
  const ids = new Set<string>();
  annotations.forEach((annotation, index) => {
    if (index === 0) return;
    const previous = annotations[index - 1];
    if (previous.endMs > annotation.startMs) {
      ids.add(previous.segmentId);
      ids.add(annotation.segmentId);
    }
  });
  return [...ids];
};

export const annotationCompletionIssueSegmentIds = (
  annotations: SegmentAnnotation[],
) => annotations
  .filter((annotation) =>
    !annotation.reviewed || Boolean(annotationCompletionTextIssue(annotation))
  )
  .map((annotation) => annotation.segmentId);

export function createSegmentAnnotation(
  segmentId: string,
  sequence: number,
  startMs: number,
  endMs: number,
  now = new Date().toISOString(),
): SegmentAnnotation {
  // Playhead-derived times (audio currentTime, ruler clicks) are fractional;
  // the server decodes startMs/endMs as integers and rejects fractions.
  return {
    segmentId,
    sourceSegmentIds: [],
    sequence,
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    originalAsrText: "",
    annotatedText: "",
    state: "unreviewed",
    reviewed: false,
    updatedAt: now,
  };
}

export function mergeSegmentAnnotations(
  left: SegmentAnnotation,
  right: SegmentAnnotation,
  now = new Date().toISOString(),
): SegmentAnnotation {
  return {
    ...left,
    sourceSegmentId: undefined,
    sourceSegmentIds: Array.from(
      new Set([
        ...annotationSourceSegmentIds(left),
        ...annotationSourceSegmentIds(right),
      ]),
    ),
    startMs: Math.min(left.startMs, right.startMs),
    endMs: Math.max(left.endMs, right.endMs),
    originalAsrText: joinTranscriptFragment(left.originalAsrText, right.originalAsrText),
    annotatedText: joinTranscriptFragment(left.annotatedText, right.annotatedText),
    state: "unreviewed",
    reviewed: false,
    reviewedAt: undefined,
    firstEditedAt: undefined,
    updatedAt: now,
  };
}

const splitText = (text: string, ratio: number) => {
  if (!text) return ["", ""] as const;
  const target = Math.max(
    1,
    Math.min(text.length - 1, Math.round(text.length * ratio)),
  );
  const punctuation = /[，。！？；：,.!?;:\s]/;
  let splitAt = target;
  for (let distance = 0; distance < Math.min(12, text.length); distance += 1) {
    const after = target + distance;
    const before = target - distance;
    if (after < text.length && punctuation.test(text[after])) {
      splitAt = after + 1;
      break;
    }
    if (before > 0 && punctuation.test(text[before - 1])) {
      splitAt = before;
      break;
    }
  }
  return [text.slice(0, splitAt), text.slice(splitAt)] as const;
};

export function splitSegmentAnnotation(
  annotation: SegmentAnnotation,
  splitMs: number,
  now = new Date().toISOString(),
): [SegmentAnnotation, SegmentAnnotation] {
  const ratio = (splitMs - annotation.startMs) / (annotation.endMs - annotation.startMs);
  const [leftOriginal, rightOriginal] = splitText(annotation.originalAsrText, ratio);
  const [leftText, rightText] = splitText(annotation.annotatedText, ratio);
  const sourceSegmentIds = annotationSourceSegmentIds(annotation);
  const base = {
    ...annotation,
    sourceSegmentId: undefined,
    sourceSegmentIds,
    state: "unreviewed" as const,
    reviewed: false,
    reviewedAt: undefined,
    firstEditedAt: undefined,
    updatedAt: now,
  };
  return [
    {
      ...base,
      segmentId: `${annotation.segmentId}~${splitMs}-a`,
      endMs: splitMs,
      originalAsrText: leftOriginal,
      annotatedText: leftText,
    },
    {
      ...base,
      segmentId: `${annotation.segmentId}~${splitMs}-b`,
      startMs: splitMs,
      originalAsrText: rightOriginal,
      annotatedText: rightText,
    },
  ];
}

export function splitSegmentAnnotationBySentences(
  annotation: SegmentAnnotation,
  sentences: string[],
  now = new Date().toISOString(),
): SegmentAnnotation[] {
  if (
    sentences.length < 2 ||
    sentences.some((sentence) => sentence.length === 0) ||
    sentences.join("") !== annotation.annotatedText
  ) {
    throw new Error("模型返回的拆句结果与当前人工结果不一致。");
  }
  const durationMs = annotation.endMs - annotation.startMs;
  if (durationMs < sentences.length * 100) {
    throw new Error("当前片段时长不足，无法为每个句子保留至少 100 毫秒。");
  }
  const sentenceLengths = sentences.map((sentence) => Array.from(sentence).length);
  const totalLength = sentenceLengths.reduce((sum, length) => sum + length, 0);
  const originalRunes = Array.from(annotation.originalAsrText);
  const sourceSegmentIds = annotationSourceSegmentIds(annotation);
  let cumulativeLength = 0;
  let previousEndMs = annotation.startMs;
  let previousOriginalOffset = 0;

  return sentences.map((sentence, index) => {
    cumulativeLength += sentenceLengths[index];
    const remaining = sentences.length - index - 1;
    const isLast = remaining === 0;
    const proportionalEndMs = annotation.startMs + Math.round(
      durationMs * cumulativeLength / totalLength,
    );
    const endMs = isLast
      ? annotation.endMs
      : Math.max(
          previousEndMs + 100,
          Math.min(proportionalEndMs, annotation.endMs - remaining * 100),
        );
    const originalOffset = isLast
      ? originalRunes.length
      : Math.round(originalRunes.length * cumulativeLength / totalLength);
    const result: SegmentAnnotation = {
      ...annotation,
      segmentId: `${annotation.segmentId}~sentence-${index + 1}`,
      sourceSegmentId: undefined,
      sourceSegmentIds,
      startMs: previousEndMs,
      endMs,
      originalAsrText: originalRunes
        .slice(previousOriginalOffset, originalOffset)
        .join(""),
      annotatedText: sentence,
      state: "unreviewed",
      reviewed: false,
      reviewedAt: undefined,
      firstEditedAt: undefined,
      updatedAt: now,
    };
    previousEndMs = endMs;
    previousOriginalOffset = originalOffset;
    return result;
  });
}
export type SubmissionPartStatus = "open" | "submitted" | "accepted" | "rejected";
export type SubmissionPart = {
  id: string;
  startMs: number;
  endMs: number;
  status: SubmissionPartStatus;
  submittedAt?: string;
  acceptedAt?: string;
  acceptedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectionReason?: string;
};
// A part is editable while it is open or has been sent back (rejected).
export const submissionPartEditable = (part: SubmissionPart) =>
  part.status === "open" || part.status === "rejected";
// Default working part: first editable one, else first pending acceptance,
// else the first part. Keeps the annotator on actionable work after reloads.
export const defaultSubmissionPartId = (parts: SubmissionPart[]) =>
  (parts.find(submissionPartEditable) ??
    parts.find((part) => part.status === "submitted") ??
    parts[0])?.id ?? "";
export type Submission = {
  id: string;
  datasetId: string;
  taskId: string;
  annotatorId: string;
  kind?: string;
  annotatorEmail?: string;
  annotatorEmailUnavailableReason?: string;
  status: string;
  version: number;
  parts?: SubmissionPart[];
  annotations: SegmentAnnotation[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  acceptedAt?: string;
  acceptedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectionReason?: string;
  // Present on review-page tracks pulled in from the same duplicate group:
  // the source task's sample name and whether it is the canonical or a copy.
  sourceSampleName?: string;
  sourceRelation?: "canonical" | "duplicate";
};

export const submissionPartCompletionState = (
  submission: Submission,
  partId: string,
) => {
  const part = (submission.parts ?? []).find((candidate) => candidate.id === partId);
  if (!part || submissionPartEditable(part)) {
    return { submitted: false, completed: false, nextPartId: "" };
  }
  return {
    submitted: true,
    completed: submission.status === "completed",
    nextPartId: (submission.parts ?? []).find(submissionPartEditable)?.id ?? "",
  };
};
export type QueueItem = {
  assignment: Assignment;
  task: Task;
  submission?: Submission;
  reviewedCount: number;
  annotationCount?: number;
  batchName?: string;
  batchEndsOn?: string;
};
export type WorkspaceCandidate = {
  kind: string;
  recordId: string;
  createdAt: string;
  sampleName: string;
  provider: string;
  model: string;
  sourceLanguage: string;
  durationMs: number;
  segmentCount: number;
  canAdd: boolean;
  unavailableReason?: string;
};
export type AnnotatorProgress = {
  datasetId: string;
  userId: string;
  workEmail: string;
  role: string;
  pending: number;
  inProgress: number;
  completed: number;
};
export type MembershipStatus = "candidate" | "formal" | "other";
export type PlatformUser = {
  id: string;
  workEmail: string;
  role: AnnotationUser["role"];
  // Absent/empty means 候选人 (candidate); owners promote members to 正式 (formal).
  membershipStatus?: MembershipStatus;
  registeredAt: string;
  lastLoginAt: string;
  channels: string[];
  datasetCount: number;
  pendingCount: number;
  inProgressCount: number;
  completedCount: number;
  assignedAudioDurationMs: number;
  completedAudioDurationMs: number;
  // 校验者 tally: submissions this member accepted (per acceptance action) and
  // the cumulative audio duration of those accepted tasks.
  acceptedCount: number;
  acceptedAudioDurationMs: number;
  // 标注员 outcome tally: audio duration of this member's own submissions that
  // passed 验收 vs were marked 不通过.
  passedAudioDurationMs: number;
  rejectedAudioDurationMs: number;
};
export type PlatformUserIdentity = Pick<
  PlatformUser,
  "id" | "workEmail" | "role" | "registeredAt" | "lastLoginAt" | "channels"
>;
export type PlatformDataItem = {
  scene?: string;
  sourceLanguage?: string;
  datasetId: string;
  datasetName: string;
  datasetStatus: string;
  taskId: string;
  sampleName: string;
  sourceKind: string;
  uploaderUserId?: string;
  uploaderEmail?: string;
  uploaderUnavailableReason?: string;
  durationMs: number;
  segmentCount: number;
  requiredAnnotatorCount: number;
  taskStatus?: "open" | "closed" | "retired";
  duplicateOf?: { datasetId: string; taskId: string };
  duplicateOfSampleName?: string;
  duplicateCount?: number;
  assignmentCount: number;
  pendingCount: number;
  inProgressCount: number;
  completedCount: number;
  acceptedCount?: number;
  pendingAcceptanceCount?: number;
  rejectedCount?: number;
  acceptanceState?: "waiting_completion" | "pending_acceptance" | "accepted";
  createdAt: string;
  canOpen: boolean;
  datasetOverview?: DatasetStats;
  batch?: BatchRef;
};
export type BatchRef = { id: string; name: string };
export type BatchStatus = "open" | "paused" | "closed" | "archived";
export type BatchStats = {
  taskCount: number;
  durationMs: number;
  assignedTaskCount: number;
  completedTaskCount: number;
  pendingAcceptanceTaskCount: number;
  acceptedTaskCount: number;
  annotatorCount: number;
  completionRate: number;
};
export const emptyBatchStats: BatchStats = {
  taskCount: 0, durationMs: 0, assignedTaskCount: 0, completedTaskCount: 0,
  pendingAcceptanceTaskCount: 0, acceptedTaskCount: 0, annotatorCount: 0, completionRate: 0,
};
export type Batch = {
  id: string;
  datasetId: string;
  name: string;
  description?: string;
  status: BatchStatus;
  priority: number;
  startsOn?: string;
  endsOn?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  stats: BatchStats;
  overdue: boolean;
};
export type BatchInput = {
  name?: string;
  description?: string;
  priority?: number;
  startsOn?: string;
  endsOn?: string;
  taskIds?: string[];
  idempotencyKey?: string;
};
export type PlatformUserTask = {
  scene?: string;
  sourceLanguage?: string;
  datasetId: string;
  datasetName: string;
  datasetStatus: string;
  datasetVersion: number;
  taskId: string;
  sampleName: string;
  sourceKind: string;
  durationMs: number;
  segmentCount: number;
  taskStatus?: "open" | "closed";
  memberAssignmentId: string;
  memberAssignmentStatus: "pending" | "in_progress" | "completed";
  workState: "current" | "completed" | "pending_acceptance" | "accepted" | "closed" | "retired" | "recalled";
  current: boolean;
  assignedAt: string;
  startedAt?: string;
  completedAt?: string;
  canOpen: boolean;
  batch?: BatchRef;
};
export type ImportJob = {
  id: string;
  datasetId: string;
  externalId: string;
  sampleName: string;
  status: string;
  taskId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
};

export class AnnotationApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public requestId = "",
    public traceId = "",
  ) {
    super(message);
  }
}
async function request<T>(
  path: string,
  init?: RequestInit,
  traceContext = createApiTraceContext(),
): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    }, traceContext);
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    throw new AnnotationApiError(
      timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
      timedOut ? "请求等待超时，请稍后重试。" : "连接中断，请检查网络后重试。",
      true,
      traceContext.requestId || "",
      traceContext.traceId,
    );
  }
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    const error = new AnnotationApiError(
      value.error?.code || "REQUEST_FAILED",
      value.error?.message || `请求失败 (${response.status})`,
      Boolean(value.error?.retryable),
      value.requestId || response.headers.get("x-request-id") || "",
      value.traceId || response.headers.get("traceparent")?.split("-")[1] || "",
    );
    if (
      response.status === 401 &&
      !window.location.pathname.startsWith("/admin/annotation/login")
    )
      window.location.assign(
        `/admin/annotation/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      );
    throw error;
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const annotationMe = () =>
  request<{ user: AnnotationUser; channel: string; membershipStatus?: string }>(
    "/api/annotation/v2/me",
  );
// 非强制登录场景（如实时同传工作台）：未登录返回 null，绝不跳转到登录页。
export const annotationMeSilent = async (): Promise<AnnotationUser | null> => {
  try {
    const response = await apiFetch("/api/annotation/v2/me", {
      credentials: "same-origin",
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { user?: AnnotationUser };
    return data.user ?? null;
  } catch {
    return null;
  }
};
export const startAnnotationLogin = (workEmail: string, password?: string) =>
  request<{
    authenticated?: boolean;
    loginId?: string;
    expiresAt?: string;
    delivery: string;
    developmentCode?: string;
    user?: AnnotationUser;
  }>("/api/annotation/v2/auth/start", {
    method: "POST",
    body: JSON.stringify({ workEmail, ...(password === undefined ? {} : { password }) }),
  });
export const verifyAnnotationLogin = (loginId: string, code: string) =>
  request<{ user: AnnotationUser }>("/api/annotation/v2/auth/verify", {
    method: "POST",
    body: JSON.stringify({ loginId, code }),
  });
export const logoutAnnotation = () =>
  request<void>("/api/annotation/v2/auth/logout", { method: "POST" });
export async function listDatasets() {
  const page: { items: Dataset[]; nextCursor: string; total: number } = await request(
    "/api/annotation/v2/datasets?limit=20",
  );
  return { items: page.items.slice(0, 20), total: page.total };
}
export const getDataset = (id: string) =>
  request<Dataset>(`/api/annotation/v2/datasets/${encodeURIComponent(id)}`);
export const updateTask = (
  datasetId: string,
  taskId: string,
  body: { requiredAnnotatorCount?: number; status?: "open" | "closed" },
) =>
  request<Task>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
export const createDataset = (body: {
  sourceLanguage?: "zh" | "ja" | "ko";
  name: string;
  description: string;
  defaultAnnotatorsPerTask: number;
  idempotencyKey: string;
}) =>
  request<Dataset>("/api/annotation/v2/datasets", {
    method: "POST",
    body: JSON.stringify(body),
  });
export async function listTasks(datasetId: string) {
  const items: Task[] = [];
  let cursor = "";
  do {
    const page: { items: Task[]; nextCursor: string } = await request(
      `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return { items };
}
export const listAssignments = () =>
  request<{ items: QueueItem[] }>("/api/annotation/v2/assignments");
export const getSubmission = (
  datasetId: string,
  taskId: string,
  traceContext?: ApiTraceContext,
  completionAttemptId = "",
) =>
  request<{ assignment: Assignment; task: Task; submission: Submission }>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/submission`,
    completionAttemptId
      ? { headers: { "X-Completion-Attempt-ID": completionAttemptId } }
      : undefined,
    traceContext,
  );
// The server decodes startMs/endMs strictly as integers; a fractional value
// anywhere in the array fails the whole save with a generic 格式无效 error, so
// timings are rounded once more at the wire boundary.
const wireAnnotations = (annotations: SegmentAnnotation[]) =>
  annotations.map((annotation) => ({
    ...annotation,
    startMs: Math.round(annotation.startMs),
    endMs: Math.round(annotation.endMs),
  }));
export const saveSubmission = (
  datasetId: string,
  taskId: string,
  version: number,
  annotations: SegmentAnnotation[],
  traceContext?: ApiTraceContext,
  completionAttemptId = "",
) =>
  request<Submission>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/submission`,
    {
      method: "PATCH",
      body: JSON.stringify({ version, annotations: wireAnnotations(annotations) }),
      headers: completionAttemptId
        ? { "X-Completion-Attempt-ID": completionAttemptId }
        : undefined,
    },
    traceContext,
  );
const sentenceSplitTimeoutMs = 25_000;
const sentenceSplitRetryDelayMs = 500;

export const splitAnnotationSentences = async (
  datasetId: string,
  taskId: string,
  segmentId: string,
  text: string,
) => {
  const path = `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/submission/split-sentences`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), sentenceSplitTimeoutMs);
    try {
      return await request<{ segmentId: string; sentences: string[] }>(path, {
        method: "POST",
        body: JSON.stringify({ segmentId, text }),
        signal: controller.signal,
      });
    } catch (error) {
      if (
        error instanceof AnnotationApiError &&
        error.code === "REQUEST_TIMEOUT"
      ) {
        throw new AnnotationApiError(
          "SENTENCE_SPLIT_TIMEOUT",
          "智能拆句等待超过 25 秒，请重试或手动拆分。",
          true,
          error.requestId,
          error.traceId,
        );
      }
      if (
        error instanceof AnnotationApiError &&
        error.code === "NETWORK_ERROR" &&
        attempt === 0
      ) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, sentenceSplitRetryDelayMs));
        continue;
      }
      if (error instanceof AnnotationApiError) throw error;
      throw new AnnotationApiError(
        "SENTENCE_SPLIT_NETWORK_ERROR",
        "连接中断，智能拆句未完成，请重试。",
        true,
      );
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  throw new AnnotationApiError(
    "SENTENCE_SPLIT_NETWORK_ERROR",
    "连接中断，智能拆句未完成，请重试。",
    true,
  );
};
export const completeSubmission = (
  datasetId: string,
  taskId: string,
  version: number,
  confirmOverlap = false,
  traceContext?: ApiTraceContext,
  completionAttemptId = "",
  signal?: AbortSignal,
) =>
  request<Submission>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/submission/complete`,
    {
      method: "POST",
      body: JSON.stringify({ version, confirmOverlap }),
      headers: completionAttemptId
        ? { "X-Completion-Attempt-ID": completionAttemptId }
        : undefined,
      signal,
    },
    traceContext,
  );
export const checkSubmissionQualityBatch = (
  datasetId: string,
  taskId: string,
  version: number,
  traceContext?: ApiTraceContext,
  completionAttemptId = "",
  signal?: AbortSignal,
) =>
  request<{
    submission: Submission;
    checked: number;
    total: number;
    done: boolean;
    issues: AnnotationQualityIssue[];
  }>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/submission/quality-check`,
    {
      method: "POST",
      body: JSON.stringify({ version }),
      headers: completionAttemptId
        ? { "X-Completion-Attempt-ID": completionAttemptId }
        : undefined,
      signal,
    },
    traceContext,
  );
export const checkSubmissionPartQualityBatch = (
  datasetId: string,
  taskId: string,
  version: number,
  partId: string,
  traceContext?: ApiTraceContext,
  completionAttemptId = "",
  signal?: AbortSignal,
) =>
  request<{
    version: number;
    annotations: SegmentAnnotation[];
    checked: number;
    total: number;
    done: boolean;
    issues: AnnotationQualityIssue[];
  }>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/submission/quality-check`,
    {
      method: "POST",
      body: JSON.stringify({ version, partId, compact: true }),
      headers: completionAttemptId
        ? { "X-Completion-Attempt-ID": completionAttemptId }
        : undefined,
      signal,
    },
    traceContext,
  );
export const disputeSubmissionQuality = (
  datasetId: string,
  taskId: string,
  version: number,
  segmentId: string,
) =>
  request<Submission>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/submission/quality-dispute`,
    { method: "POST", body: JSON.stringify({ version, segmentId }) },
  );
export const reopenSubmission = (
  datasetId: string,
  taskId: string,
  version: number,
) =>
  request<Submission>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/submission/reopen`,
    { method: "POST", body: JSON.stringify({ version, confirm: true }) },
  );
export const listWorkspaceCandidates = () =>
  request<{ items: WorkspaceCandidate[] }>(
    "/api/annotation/v2/workspace-items/candidates",
  );
export const addWorkspaceItems = (
  datasetId: string,
  items: Array<Pick<WorkspaceCandidate, "kind" | "recordId" | "createdAt">>,
  batchId = "",
) =>
  request<{ items: Task[] }>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/workspace-items`,
    { method: "POST", body: JSON.stringify(batchId ? { items, batchId } : { items }) },
  );
export const createAssignments = (
  datasetId: string,
  taskIds: string[],
  workEmails: string[],
  batchId = "",
) =>
  request<{ items: Assignment[] }>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/assignments:batch`,
    { method: "POST", body: JSON.stringify(batchId && !taskIds.length ? { batchId, workEmails } : { taskIds, workEmails }) },
  );
// --- 批次 -------------------------------------------------------------------
const batchPath = (datasetId: string, batchId = "") =>
  `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/batches${batchId ? `/${encodeURIComponent(batchId)}` : ""}`;
export const listBatches = (datasetId: string, options: { includeArchived?: boolean } = {}) =>
  request<{ items: Batch[]; unbatched: BatchStats }>(
    `${batchPath(datasetId)}${options.includeArchived ? "?includeArchived=1" : ""}`,
  );
export const createBatch = (datasetId: string, body: BatchInput) =>
  request<Batch>(batchPath(datasetId), { method: "POST", body: JSON.stringify(body) });
export const updateBatch = (datasetId: string, batchId: string, body: BatchInput) =>
  request<Batch>(batchPath(datasetId, batchId), { method: "PATCH", body: JSON.stringify(body) });
export const deleteBatch = (datasetId: string, batchId: string) =>
  request<void>(batchPath(datasetId, batchId), { method: "DELETE" });
export type BatchAction = "pause" | "resume" | "close" | "archive";
export const transitionBatch = (
  datasetId: string,
  batchId: string,
  action: BatchAction,
  options: { force?: boolean } = {},
) =>
  request<Batch>(`${batchPath(datasetId, batchId)}/${action}`, {
    method: "POST",
    body: JSON.stringify(options.force ? { force: true } : {}),
  });
export const moveTasksToBatch = (datasetId: string, batchId: string, taskIds: string[]) =>
  request<{ batch: Batch; movedCount: number }>(`${batchPath(datasetId, batchId)}/tasks:move`, {
    method: "POST",
    body: JSON.stringify({ taskIds }),
  });
export const removeTasksFromBatch = (datasetId: string, batchId: string, taskIds: string[]) =>
  request<{ batch: Batch; removedCount: number }>(`${batchPath(datasetId, batchId)}/tasks:remove`, {
    method: "POST",
    body: JSON.stringify({ taskIds }),
  });
export type AssignmentAllocationResult = {
  status: string;
  requestedDurationMs: number;
  assignedDurationMs: number;
  overshootDurationMs?: number;
  assignmentCount: number;
  complete: boolean;
  idempotentReplay?: boolean;
};
export const allocateAssignmentsByDuration = (body: {
  workEmail: string;
  requestedDurationMs: number;
  batchIds?: string[];
  confirm: boolean;
  idempotencyKey?: string;
}) =>
  request<AssignmentAllocationResult>("/api/annotation/v2/platform/assignment-allocations", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const listAnnotators = (datasetId: string) =>
  request<{ items: AnnotatorProgress[] }>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/annotators`,
  );
export const listDatasetMembers = (datasetId: string) =>
  request<{ items: DatasetMember[] }>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/members`,
  );
export const listImports = (datasetId: string) =>
  request<{ items: ImportJob[] }>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/imports`,
  );
// setRangeParam appends a numeric filter bound only when it is a finite,
// non-negative number, so blank inputs stay absent (treated as "no bound") and
// never emit NaN/negative query values.
function setRangeParam(parameters: URLSearchParams, key: string, value?: number) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    parameters.set(key, String(Math.trunc(value)));
  }
}

export async function listPlatformUsers(options: {
  cursor?: string;
  query?: string;
  role?: string;
  status?: string;
  sort?: string;
  direction?: "ascending" | "descending";
  // Column range/date filters (durations already in milliseconds; dates ISO).
  taskPendMin?: number;
  taskProgMin?: number;
  taskDoneMin?: number;
  cAudMinMs?: number;
  cAudMaxMs?: number;
  aAudMinMs?: number;
  aAudMaxMs?: number;
  accMin?: number;
  accMax?: number;
  accAudMinMs?: number;
  accAudMaxMs?: number;
  regFrom?: string;
  regTo?: string;
  loginFrom?: string;
  loginTo?: string;
} = {}) {
  const parameters = new URLSearchParams({ limit: "20" });
  if (options.cursor) parameters.set("cursor", options.cursor);
  if (options.query?.trim()) parameters.set("query", options.query.trim());
  if (options.role && options.role !== "all") parameters.set("role", options.role);
  if (options.status && options.status !== "all") parameters.set("status", options.status);
  if (options.sort) parameters.set("sort", options.sort);
  if (options.direction) parameters.set("direction", options.direction);
  setRangeParam(parameters, "taskPendMin", options.taskPendMin);
  setRangeParam(parameters, "taskProgMin", options.taskProgMin);
  setRangeParam(parameters, "taskDoneMin", options.taskDoneMin);
  setRangeParam(parameters, "cAudMinMs", options.cAudMinMs);
  setRangeParam(parameters, "cAudMaxMs", options.cAudMaxMs);
  setRangeParam(parameters, "aAudMinMs", options.aAudMinMs);
  setRangeParam(parameters, "aAudMaxMs", options.aAudMaxMs);
  setRangeParam(parameters, "accMin", options.accMin);
  setRangeParam(parameters, "accMax", options.accMax);
  setRangeParam(parameters, "accAudMinMs", options.accAudMinMs);
  setRangeParam(parameters, "accAudMaxMs", options.accAudMaxMs);
  if (options.regFrom) parameters.set("regFrom", options.regFrom);
  if (options.regTo) parameters.set("regTo", options.regTo);
  if (options.loginFrom) parameters.set("loginFrom", options.loginFrom);
  if (options.loginTo) parameters.set("loginTo", options.loginTo);
  const page: {
    items: PlatformUser[];
    nextCursor: string;
    total: number;
    registeredTotal?: number;
    formalTotal?: number;
    candidateTotal?: number;
  } = await request(`/api/annotation/v2/platform/users?${parameters.toString()}`);
  return {
    items: page.items.slice(0, 20),
    nextCursor: page.nextCursor,
    total: page.total,
    registeredTotal: page.registeredTotal ?? page.total,
    formalTotal: page.formalTotal ?? 0,
    candidateTotal: page.candidateTotal ?? 0,
  };
}
// WorkloadBucket is one member's 完成标注/校验通过 tallies for a scope:
// all-time (date absent) or a single client-timezone day.
export type WorkloadBucket = {
  date?: string;
  completedCount: number;
  completedAudioDurationMs: number;
  acceptedCount: number;
  acceptedAudioDurationMs: number;
};
export type WorkloadMember = {
  userId: string;
  workEmail: string;
  role: string;
  total: WorkloadBucket;
  daily: WorkloadBucket[];
};
// getPlatformWorkload returns every registered member's annotation workload,
// all-time plus per-day in the viewer's timezone (owner/admin only).
export const getPlatformWorkload = () =>
  request<{ members: WorkloadMember[] }>(
    `/api/annotation/v2/platform/workload?tz=${new Date().getTimezoneOffset()}`,
  );
export async function listPlatformUserTasks(userId: string) {
  const items: PlatformUserTask[] = [];
  let cursor = "";
  let total = 0;
  let user: PlatformUserIdentity | null = null;
  do {
    const page: {
      user: PlatformUserIdentity;
      items: PlatformUserTask[];
      nextCursor: string;
      total: number;
    } = await request(
      `/api/annotation/v2/platform/users/${encodeURIComponent(userId)}/tasks?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    user = page.user;
    items.push(...page.items);
    total = page.total;
    cursor = page.nextCursor;
  } while (cursor);
  return { user, items, total };
}
export const revokePlatformUserTask = (
  datasetId: string,
  assignmentId: string,
) =>
  request<void>(
    `/api/annotation/v2/platform/datasets/${encodeURIComponent(datasetId)}/assignments/${encodeURIComponent(assignmentId)}`,
    { method: "DELETE", body: JSON.stringify({ confirm: true }) },
  );
export const updatePlatformUserRole = (
  userId: string,
  role: "member" | "admin",
) =>
  request<PlatformUser>(
    `/api/annotation/v2/platform/users/${encodeURIComponent(userId)}`,
    { method: "PATCH", body: JSON.stringify({ role }) },
  );
export const updatePlatformUserStatus = (
  userId: string,
  membershipStatus: MembershipStatus,
) =>
  request<PlatformUser>(
    `/api/annotation/v2/platform/users/${encodeURIComponent(userId)}`,
    { method: "PATCH", body: JSON.stringify({ membershipStatus }) },
  );
export async function listPlatformDataItems(options: {
  cursor?: string;
  query?: string;
  status?: string;
  source?: string;
  sort?: string;
  direction?: "ascending" | "descending";
  // Column range filters (durations already in milliseconds).
  durMinMs?: number;
  durMaxMs?: number;
  segMin?: number;
  segMax?: number;
  doneMin?: number;
  doneMax?: number;
  assignMin?: number;
  assignMax?: number;
  // 批次 id，或 "none" = 未分批。
  batch?: string;
  // 是否把已关闭/已归档批次里的任务也列出来并计入统计（默认不含）。
  includeEnded?: boolean;
} = {}) {
  const parameters = new URLSearchParams({ limit: "20" });
  if (options.batch && options.batch !== "all") parameters.set("batch", options.batch);
  if (options.includeEnded) parameters.set("ended", "1");
  if (options.cursor) parameters.set("cursor", options.cursor);
  if (options.query?.trim()) parameters.set("query", options.query.trim());
  if (options.status && options.status !== "all") parameters.set("status", options.status);
  if (options.source && options.source !== "all") parameters.set("source", options.source);
  if (options.sort) parameters.set("sort", options.sort);
  if (options.direction) parameters.set("direction", options.direction);
  setRangeParam(parameters, "durMinMs", options.durMinMs);
  setRangeParam(parameters, "durMaxMs", options.durMaxMs);
  setRangeParam(parameters, "segMin", options.segMin);
  setRangeParam(parameters, "segMax", options.segMax);
  setRangeParam(parameters, "doneMin", options.doneMin);
  setRangeParam(parameters, "doneMax", options.doneMax);
  setRangeParam(parameters, "assignMin", options.assignMin);
  setRangeParam(parameters, "assignMax", options.assignMax);
  const page: {
    items: PlatformDataItem[];
    nextCursor: string;
    total: number;
    totals?: PlatformDataTotals;
  } = await request(`/api/annotation/v2/platform/data-items?${parameters.toString()}`);
  return {
    items: page.items.slice(0, 20),
    nextCursor: page.nextCursor,
    total: page.total,
    totals: { ...emptyPlatformDataTotals, ...page.totals },
  };
}
export type PlatformDataTotals = {
  totalTaskCount: number;
  acceptedTaskCount: number;
  pendingAcceptanceTaskCount: number;
  totalDurationMs: number;
  completedDurationMs?: number;
  remainingDurationMs?: number;
  acceptedDurationMs: number;
  pendingAcceptanceDurationMs: number;
  totalWorkDurationMs?: number;
  completedWorkDurationMs?: number;
  acceptedWorkDurationMs?: number;
  remainingWorkDurationMs?: number;
};

export type ReviewAssignment = {
  id: string;
  datasetId: string;
  taskId: string;
  reviewerId: string;
  workEmail: string;
  status: "pending" | "in_progress" | "completed";
  assignedBy: string;
  assignedAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type ReviewQueueItem = {
  datasetId: string;
  datasetName: string;
  taskId: string;
  sampleName: string;
  durationMs: number;
  segmentCount: number;
  draftInProgress?: boolean;
  assignment?: ReviewAssignment;
};

export type ReviewCandidate = PlatformUserIdentity & {
  membershipStatus?: MembershipStatus;
};

export const listReviewQueue = () =>
  request<{ items: ReviewQueueItem[]; reviewers: ReviewCandidate[] }>(
    "/api/annotation/v2/platform/review-queue",
  );

export const createReviewAssignments = (
  reviewerId: string,
  taskRefs: Array<{ datasetId: string; taskId: string }>,
) => request<{ items: ReviewAssignment[] }>(
  "/api/annotation/v2/platform/review-assignments",
  { method: "POST", body: JSON.stringify({ reviewerId, taskRefs }) },
);

export const listMyReviewAssignments = () =>
  request<{ items: ReviewQueueItem[] }>("/api/annotation/v2/review-assignments");
const emptyPlatformDataTotals: PlatformDataTotals = {
  totalTaskCount: 0,
  acceptedTaskCount: 0,
  pendingAcceptanceTaskCount: 0,
  totalDurationMs: 0,
  acceptedDurationMs: 0,
  pendingAcceptanceDurationMs: 0,
};
export const createMember = (
  datasetId: string,
  workEmail: string,
  role: "annotator" | "viewer" | "admin",
) =>
  request(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/members`,
    { method: "POST", body: JSON.stringify({ workEmail, role }) },
  );
export const updateDatasetMemberRole = (
  datasetId: string,
  userId: string,
  role: Exclude<DatasetMemberRole, "owner">,
) =>
  request<DatasetMember>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/members/${encodeURIComponent(userId)}`,
    { method: "PATCH", body: JSON.stringify({ role, confirm: false }) },
  );
export const reviewTask = (datasetId: string, taskId: string) =>
  request<{ task: Task; submissions: Submission[]; linkedSubmissions?: Submission[]; readOnly: true; memberRole: DatasetMemberRole; canAccept: boolean }>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/review`,
  );
export const acceptSubmission = (
  datasetId: string,
  taskId: string,
  submissionId: string,
  version: number,
) =>
  request<{ submission: Submission; task: Task; acceptedCount: number; idempotentReplay?: boolean }>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/submissions/${encodeURIComponent(submissionId)}/accept`,
    { method: "POST", body: JSON.stringify({ version }) },
  );
export const rejectSubmission = (
  datasetId: string,
  taskId: string,
  submissionId: string,
  version: number,
  reason: string,
) =>
  request<{ submission: Submission; task: Task }>(
    `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/submissions/${encodeURIComponent(submissionId)}/reject`,
    { method: "POST", body: JSON.stringify({ version, reason }) },
  );
// 任务分段(submission parts):标注员把长任务切成可独立提交/验收的分段。
// 服务端可能直接返回 Submission,也可能返回 { submission } 信封;统一归一化。
const submissionFromEnvelope = (result: Submission | { submission: Submission }) =>
  "submission" in result ? result.submission : result;
const submissionURL = (datasetId: string, taskId: string, suffix: string) =>
  `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}${suffix}`;
export const splitSubmissionPart = async (
  datasetId: string,
  taskId: string,
  atMs: number,
  version: number,
) =>
  submissionFromEnvelope(
    await request<Submission | { submission: Submission }>(
      submissionURL(datasetId, taskId, "/submission/parts:split"),
      { method: "POST", body: JSON.stringify({ atMs: Math.round(atMs), version }) },
    ),
  );
export const mergeSubmissionParts = async (
  datasetId: string,
  taskId: string,
  boundaryMs: number,
  version: number,
) =>
  submissionFromEnvelope(
    await request<Submission | { submission: Submission }>(
      submissionURL(datasetId, taskId, "/submission/parts:merge"),
      { method: "POST", body: JSON.stringify({ boundaryMs: Math.round(boundaryMs), version }) },
    ),
  );
export const completeSubmissionPart = async (
  datasetId: string,
  taskId: string,
  partId: string,
  version: number,
  confirmOverlap = false,
  traceContext?: ApiTraceContext,
  completionAttemptId = "",
  signal?: AbortSignal,
) =>
  submissionFromEnvelope(
    await request<Submission | { submission: Submission }>(
      submissionURL(datasetId, taskId, `/submission/parts/${encodeURIComponent(partId)}/complete`),
      {
        method: "POST",
        body: JSON.stringify({ version, confirmOverlap }),
        headers: completionAttemptId
          ? { "X-Completion-Attempt-ID": completionAttemptId }
          : undefined,
        signal,
      },
      traceContext,
    ),
  );
export const acceptSubmissionPart = (
  datasetId: string,
  taskId: string,
  submissionId: string,
  partId: string,
  version: number,
) =>
  request<{ submission: Submission; task?: Task }>(
    submissionURL(datasetId, taskId, `/submissions/${encodeURIComponent(submissionId)}/parts/${encodeURIComponent(partId)}/accept`),
    { method: "POST", body: JSON.stringify({ version }) },
  );
export const rejectSubmissionPart = (
  datasetId: string,
  taskId: string,
  submissionId: string,
  partId: string,
  version: number,
  reason: string,
) =>
  request<{ submission: Submission; task?: Task }>(
    submissionURL(datasetId, taskId, `/submissions/${encodeURIComponent(submissionId)}/parts/${encodeURIComponent(partId)}/reject`),
    { method: "POST", body: JSON.stringify({ version, reason }) },
  );
// Review draft (校对稿): an owner/admin-authored master submission seeded from an
// annotator's records and edited with the full annotation toolkit. It never
// mutates any annotator submission and is excluded from annotator acceptance math.
const reviewDraftURL = (datasetId: string, taskId: string, suffix = "") =>
  `/api/annotation/v2/datasets/${encodeURIComponent(datasetId)}/tasks/${encodeURIComponent(taskId)}/review-draft${suffix}`;
export const getReviewDraft = (datasetId: string, taskId: string) =>
  request<{ task: Task; submission: Submission }>(reviewDraftURL(datasetId, taskId));
export const saveReviewDraft = (
  datasetId: string,
  taskId: string,
  version: number,
  annotations: SegmentAnnotation[],
) =>
  request<Submission>(reviewDraftURL(datasetId, taskId), {
    method: "PUT",
    body: JSON.stringify({ version, annotations: wireAnnotations(annotations) }),
  });
export const seedReviewDraft = (
  datasetId: string,
  taskId: string,
  version: number,
  sourceSubmissionId: string,
) =>
  request<Submission>(reviewDraftURL(datasetId, taskId, "/seed"), {
    method: "POST",
    body: JSON.stringify({ version, sourceSubmissionId }),
  });
export const completeReviewDraft = (
  datasetId: string,
  taskId: string,
  version: number,
  confirmOverlap = false,
) =>
  request<{ submission: Submission; task: Task }>(reviewDraftURL(datasetId, taskId, "/complete"), {
    method: "POST",
    body: JSON.stringify({ version, confirmOverlap }),
  });
export const reopenReviewDraft = (datasetId: string, taskId: string, version: number) =>
  request<{ submission: Submission; task: Task }>(reviewDraftURL(datasetId, taskId, "/reopen"), {
    method: "POST",
    body: JSON.stringify({ version }),
  });
export const taskAudioURL = (task: Task) =>
  task.source.kind === "mcp_upload"
    ? `/api/annotation/v2/datasets/${encodeURIComponent(task.datasetId)}/tasks/${encodeURIComponent(task.id)}/audio`
    : task.audioUrl;
export const taskWaveformURL = (task: Task) =>
  task.source.kind === "mcp_upload"
    ? `/api/annotation/v2/datasets/${encodeURIComponent(task.datasetId)}/tasks/${encodeURIComponent(task.id)}/waveform`
    : undefined;
export const formatAnnotationTime = (ms: number) =>
  `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(Math.floor(ms % 1000)).padStart(3, "0")}`;
export const formatAnnotationDuration = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const wholeMs = Math.floor(ms);
  if (wholeMs === 0) return "0 秒";
  const hours = Math.floor(wholeMs / 3_600_000);
  const minutes = Math.floor((wholeMs % 3_600_000) / 60_000);
  const seconds = ((wholeMs % 60_000) / 1000).toFixed(3);
  if (hours) return `${hours} 时 ${minutes} 分 ${seconds} 秒`;
  if (minutes) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
};
export function reviewSegmentAnnotation(
  annotation: SegmentAnnotation,
  text = annotation.annotatedText,
  now = new Date().toISOString(),
): SegmentAnnotation {
  const originalEmpty = !annotation.originalAsrText.trim();
  const resultEmpty = !text.trim();
  const state: SegmentAnnotation["state"] = originalEmpty
    ? resultEmpty
      ? "still_empty"
      : "human_filled"
    : text === annotation.originalAsrText
      ? "asr_unchanged"
      : "human_edited";
  return {
    ...annotation,
    annotatedText: text,
    state,
    reviewed: true,
    reviewedAt: annotation.reviewedAt || now,
    firstEditedAt:
      text !== annotation.originalAsrText
        ? annotation.firstEditedAt || now
        : annotation.firstEditedAt,
    updatedAt: now,
  };
}

export function annotationCompletionTextIssue(
  annotation: SegmentAnnotation,
): string | undefined {
  if (!annotation.annotatedText.trim()) {
    return "人工结果不能为空；请补写这句话，或删除该空白片段。";
  }
  if (!/\p{P}/u.test(annotation.annotatedText)) {
    return "人工结果必须包含至少一个标点符号；请补充中英文标点后再提交。";
  }
  return undefined;
}
