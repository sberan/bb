import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type {
  PromptTextMention,
  ThreadRuntimeDisplayStatus,
  ThreadTimelineActivePromptMode,
} from "@bb/domain";
import type { ComposerView, PluginComposerScope } from "@get-bb/plugin-sdk";
import type { ComposerTextEffectSource } from "@/lib/composer-text-effects";
import { PluginComposerBanners } from "@/components/plugin/PluginComposerBanners";
import {
  PluginComposerHostProvider,
  PluginComposerViewProvider,
  type PluginComposerHost,
  usePluginComposerViewModel,
} from "@/components/plugin/plugin-composer-host";
import {
  useAppCommandContext,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import {
  PromptBoxInternal,
  type AttachmentsConfig,
  type HistoryConfig,
  type PromptBoxAction,
  type PromptBoxHandle,
  type TypeaheadConfig,
} from "@/components/promptbox/PromptBoxInternal";
import { usePromptVoice } from "@/components/promptbox/usePromptVoice";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import {
  ExecutionControls,
  type ExecutionControlsProps,
  type ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { ThreadTimelineScrollToBottomButton } from "@/views/thread-detail/ThreadTimelineScrollToBottomButton";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { ThreadContextWindowIndicator } from "@/components/thread/timeline";
import { THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT } from "@/components/promptbox/banner/ThreadPromptContextBanner";
import {
  permissionDisplayForActivePromptMode,
  permissionDisplayForPromptMode,
  shouldDisablePermissionPickerForActivePromptMode,
  shouldDisablePermissionPickerForPromptMode,
} from "./effective-prompt-mode";

type PromptBoxWithScrollAnchorProps = ComponentProps<
  typeof PromptBoxInternal
> & {
  scrollToBottomOnModifierSubmit?: boolean;
  scrollToBottomOnSubmit?: boolean;
};

function PromptBoxWithScrollAnchor({
  onSubmit,
  scrollToBottomOnModifierSubmit = true,
  scrollToBottomOnSubmit = true,
  submission,
  ...promptBoxProps
}: PromptBoxWithScrollAnchorProps) {
  const bottomAnchor = useBottomAnchoredScroll();
  const handleSubmit = () => {
    onSubmit();
    if (scrollToBottomOnSubmit) {
      bottomAnchor?.scrollToBottom();
    }
  };
  const handleModifierSubmit =
    submission?.onModifierSubmit === undefined
      ? undefined
      : () => {
          submission.onModifierSubmit?.();
          if (scrollToBottomOnModifierSubmit) {
            bottomAnchor?.scrollToBottom();
          }
        };
  const anchoredSubmission =
    submission === undefined
      ? undefined
      : {
          ...submission,
          ...(handleModifierSubmit
            ? { onModifierSubmit: handleModifierSubmit }
            : {}),
        };
  return (
    <PromptBoxInternal
      {...promptBoxProps}
      onSubmit={handleSubmit}
      submission={anchoredSubmission}
    />
  );
}

// Elastic compensation: when nothing is stacked above the textarea, the
// textarea defaults to FOLLOW_UP_PROMPT_BOX_ELASTIC_TARGET_HEIGHT so the
// prompt area is already at "with-banner" height on first paint. As the stack
// (context banner + queued messages) grows, the textarea min-height shrinks
// by the same amount — total prompt-area height stays constant and the
// thread timeline does not shift when the context banner mounts.
const FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT = 68;
const FOLLOW_UP_PROMPT_BOX_ELASTIC_TARGET_HEIGHT =
  FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT +
  THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT;
const OPEN_COMPOSER_OVERLAY_TRIGGER_SELECTOR =
  '[aria-haspopup][aria-expanded="true"]';
/**
 * How long a blurred composer stays expanded before collapsing. Long enough to
 * outlast the click that a tap on one of its own controls dispatches after the
 * blur, short enough that leaving the composer still feels immediate.
 */
const COMPOSER_COLLAPSE_SETTLE_MS = 250;
const DEFAULT_FOLLOW_UP_COMPOSER_SCOPE = {
  kind: "new-thread",
  projectId: null,
} as const;

/**
 * Discriminated state for the composer's submit affordances. Replaces the
 * previous canSendFollowUp / canQueueFollowUp / canStopRuntime / onStop
 * boolean soup. The caller computes one of these from runtimeDisplayStatus +
 * pending-interaction state and passes it down; the composer reads .kind to
 * render submit/queue/stop affordances.
 */
export type FollowUpBlockedReason =
  | "loading-execution-options"
  | "loading-pending-interactions"
  | "pending-interaction"
  | "provisioning"
  | "stopping"
  | "unavailable";

export type FollowUpSubmitMode =
  /** Idle thread — submit creates a new turn; no stop affordance. */
  | { kind: "ready" }
  /** Runtime is active or host-reconnecting — submit queues the message; stop the runtime. */
  | { kind: "queue"; onStop: () => void }
  /** Runtime is pre-start or waiting on the host — can't send/queue, but can stop. */
  | { kind: "stop-only"; onStop: () => void }
  /** Can't submit and can't stop — show why. */
  | { kind: "blocked"; reason: FollowUpBlockedReason };

export interface FollowUpComposerProps {
  history: HistoryConfig;
  /** True while the send/queue mutation is in flight. Orthogonal to submitMode. */
  isFollowUpSubmitting: boolean;
  message: string;
  mentionRanges: readonly PromptTextMention[];
  onChangeMessage: (value: string, mentionRanges: PromptTextMention[]) => void;
  onModifierSubmit: () => void;
  onSubmit: () => void;
  /** Accessible label and tooltip for the primary submit action. */
  submitTitle?: string;
  compactPromptPlaceholder: string;
  promptPlaceholder: string;
  canModifierSubmit: boolean;
  /**
   * While the runtime is active, use Enter for steer and the modifier shortcut
   * for queue. False preserves the default Enter-to-queue behavior.
   */
  steerActiveThreadOnEnter: boolean;
  submitMode: FollowUpSubmitMode;
  /** Used by the scroll-to-bottom button to know whether the runtime is actively streaming. */
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
}

type ContextWindowUsage = ComponentProps<
  typeof ThreadContextWindowIndicator
>["usage"];

export interface FollowUpPromptBoxProps {
  id?: string;
  attachments: AttachmentsConfig;
  /**
   * Slot for the stack of context cards above the prompt input — today
   * <ContextBanner> + <QueuedMessagesList>, both wrapped in PromptStackCard
   * chrome. The caller composes whatever should render above the composer
   * and passes it as a single element. Pass null to hide the stack entirely.
   */
  stack: ReactNode | null;
  activePromptMode?: ThreadTimelineActivePromptMode | null;
  composer: FollowUpComposerProps | null;
  /** Slot for the read-only environment strip in the bottom row. Pass null to hide. */
  environmentSummary: ReactNode | null;
  /**
   * Token usage indicator shown to the right of the permission picker. Null
   * means no usage available yet (e.g. thread just created); the indicator is
   * hidden in that case.
   */
  contextWindowUsage: ContextWindowUsage | null;
  /**
   * Execution controls (provider + model + service tier + reasoning) rendered
   * in PromptBox's footer slot. Callers omit provider.onChange so the picker
   * renders the provider as locked — follow-ups can't change provider, the
   * thread is already committed.
   */
  execution: ExecutionControlsProps;
  /** Permission mode picker rendered in the bottom row. */
  permission: ExecutionPermissionConfig;
  /**
   * Render all footer controls (model/reasoning + permission pickers) as
   * non-interactive, dimmed labels. The composer text input stays editable.
   */
  readOnly?: boolean;
  /** Override only the execution controls' readonly state. */
  executionReadOnly?: boolean;
  /** Override only the permission picker's readonly state. */
  permissionReadOnly?: boolean;
  typeahead: TypeaheadConfig;
  promptActions?: readonly PromptBoxAction[];
  /** Suppress plugin customizations while a retained secondary composer is inactive. */
  suppressPluginComposerCustomizations?: boolean;
  /** Optional transient draft host exposed to plugin composer hooks. */
  pluginComposerHost?: PluginComposerHost | null;
  /** Active scope used to filter and lifecycle-key plugin banner slots. */
  pluginComposerScope?: PluginComposerScope | null;
  textEffects?: readonly ComposerTextEffectSource[];
  /** zenMode resetKey — typically the active thread id, so zen-mode collapses on thread change. */
  zenModeResetKey: string | number;
  /**
   * Changing this refocuses the composer caret to the end — e.g. after editing a
   * queued message restores its text into the draft.
   */
  focusEndKey?: string | number;
  /**
   * Whether this is the pane's primary composer (the main thread box) rather
   * than a secondary one such as a side-chat composer, which stays mounted but
   * hidden. Only the primary composer answers the pane-scoped Cmd+Shift+C /
   * Cmd+Shift+M fallback when the caret is outside every composer. Defaults to
   * true; side chats pass false. Marks the composer shell via
   * `data-app-composer-role` so the model picker can read the same signal.
   */
  isPrimaryComposer?: boolean;
  /** Inline queue editors do not own a timeline scroll control. */
  showScrollToBottomButton?: boolean;
}

type FollowUpPromptBoxWithComposerProps = Omit<
  FollowUpPromptBoxProps,
  "composer"
> & {
  composer: FollowUpComposerProps;
};

function FollowUpPromptBoxStackOnly({
  stack,
  pluginComposerHost,
  pluginComposerScope,
}: Pick<
  FollowUpPromptBoxProps,
  "stack" | "pluginComposerHost" | "pluginComposerScope"
>) {
  const composerScope =
    pluginComposerScope ?? pluginComposerHost?.scope ?? null;
  const composerView = usePluginComposerViewModel({
    scope: composerScope ?? DEFAULT_FOLLOW_UP_COMPOSER_SCOPE,
    layout: "expanded",
    text: pluginComposerHost?.draft.text ?? "",
    attachmentCount: pluginComposerHost?.draft.attachments.length ?? 0,
    isRunning: false,
    isSubmitting: false,
  });
  if (!stack && !composerScope) {
    return null;
  }
  return (
    <PluginComposerViewProvider value={composerView}>
      <PluginComposerHostProvider value={pluginComposerHost ?? null}>
        <div data-promptbox-shell="" className="space-y-2">
          <div className="grid gap-2">
            {composerScope ? <PluginComposerBanners /> : null}
            {stack}
          </div>
        </div>
      </PluginComposerHostProvider>
    </PluginComposerViewProvider>
  );
}

function FollowUpPromptBoxWithComposer({
  id,
  attachments,
  stack,
  activePromptMode,
  composer,
  environmentSummary,
  contextWindowUsage,
  execution,
  permission,
  readOnly,
  executionReadOnly,
  permissionReadOnly,
  typeahead,
  promptActions,
  suppressPluginComposerCustomizations,
  pluginComposerHost,
  pluginComposerScope,
  textEffects,
  zenModeResetKey,
  focusEndKey,
  isPrimaryComposer = true,
  showScrollToBottomButton = true,
}: FollowUpPromptBoxWithComposerProps) {
  const submitMode = composer.submitMode;
  const canQueueFollowUp = submitMode.kind === "queue";
  const canSubmit = submitMode.kind === "ready" || submitMode.kind === "queue";
  const isStopping =
    submitMode.kind === "blocked" && submitMode.reason === "stopping";
  const isLoadingExecutionOptions =
    submitMode.kind === "blocked" &&
    submitMode.reason === "loading-execution-options";
  const isLoadingPendingInteractions =
    submitMode.kind === "blocked" &&
    submitMode.reason === "loading-pending-interactions";
  const isProvisioning =
    submitMode.kind === "blocked" && submitMode.reason === "provisioning";
  const isUnavailable =
    submitMode.kind === "blocked" && submitMode.reason === "unavailable";
  const onStopRuntime =
    submitMode.kind === "queue" || submitMode.kind === "stop-only"
      ? submitMode.onStop
      : undefined;
  const canStopRuntime = onStopRuntime !== undefined;
  const attachmentCount = attachments.items?.length ?? 0;
  const composerScope =
    pluginComposerScope ?? pluginComposerHost?.scope ?? null;
  const [composerLayout, setComposerLayout] =
    useState<ComposerView["layout"]>("expanded");
  const composerView = usePluginComposerViewModel({
    scope: composerScope ?? DEFAULT_FOLLOW_UP_COMPOSER_SCOPE,
    layout: composerLayout,
    text: composer.message,
    attachmentCount,
    isRunning: canStopRuntime,
    isSubmitting: composer.isFollowUpSubmitting || isStopping,
  });
  const promptBoxRef = useRef<PromptBoxHandle>(null);
  // Scope Cmd+Shift+C to the focused pane's primary composer. Every mounted
  // composer registers this handler — including side-chat composers that stay
  // mounted while hidden — so gating on both the focused pane and "primary"
  // keeps a hidden side chat from stealing the chord. Standalone/single-pane
  // surfaces have no pane context and default to focused.
  const paneContext = useOptionalPaneContext();
  const isFocusedPane = paneContext?.isFocused ?? true;
  useAppCommandContext("promptAvailable", true);
  useAppCommandHandler("composer.focus", () => {
    if (!isFocusedPane || !isPrimaryComposer) return false;
    promptBoxRef.current?.focusEnd();
    return promptBoxRef.current !== null;
  });
  const voice = usePromptVoice(promptBoxRef);
  const isCompactViewport = useIsCompactViewport();
  const isPointerCoarse = usePointerCoarse();
  // The composer still expands when you focus it — it just does it in the same
  // frame as the tap now. It used to wait for a visual-viewport resize (or a
  // 350ms fallback when iOS never reported one), then tween `height` for
  // another 240ms, which relaid out the composer and the whole timeline above
  // it on every frame of the tween. The expansion arrived long after the tap
  // that asked for it and crawled into place. Expanding synchronously lands it
  // with the keyboard, which is the motion your eye is already tracking.
  //
  // Content holds it open independently of focus, so a draft you tapped away
  // from does not collapse and hide itself behind a one-line bar.
  const composerInteractionRef = useRef<HTMLDivElement>(null);
  const pendingFocusLossFrameRef = useRef<number | null>(null);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const hasComposerContent =
    composer.message.trim().length > 0 || attachmentCount > 0;
  const isMobilePromptBoxCompact =
    isCompactViewport && !isComposerFocused && !hasComposerContent;
  const cancelPendingFocusLoss = useCallback(() => {
    if (pendingFocusLossFrameRef.current === null) return;
    window.clearTimeout(pendingFocusLossFrameRef.current);
    pendingFocusLossFrameRef.current = null;
  }, []);
  const handleComposerFocus = useCallback(() => {
    cancelPendingFocusLoss();
    setIsComposerFocused(true);
  }, [cancelPendingFocusLoss]);
  const handleComposerBlur = useCallback(() => {
    cancelPendingFocusLoss();
    // Expansion has to be instant; collapse must not be. iOS does not move
    // focus to a button when you tap one, so tapping any of the composer's own
    // controls blurs the editor and leaves focus on the document — which looks
    // exactly like leaving the composer. Collapsing on the next frame therefore
    // unmounted the control being pressed before its click was dispatched, and
    // every expanded-only button (attach, voice, the actions menu) became dead
    // while the keyboard was up. Waiting lets the click land first; the checks
    // below still decide whether the collapse was right.
    pendingFocusLossFrameRef.current = window.setTimeout(() => {
      pendingFocusLossFrameRef.current = null;
      const composerElement = composerInteractionRef.current;
      if (!composerElement) return;

      // Focus events for the element losing focus run before the browser has
      // assigned the next active element, so this is a decision about settled
      // focus rather than about pointer intent.
      if (composerElement.contains(document.activeElement)) return;

      // Responsive popovers and dropdowns portal their content outside the
      // composer. Their shared trigger contract exposes open state through
      // aria-haspopup + aria-expanded, so focus in an owned overlay must not
      // collapse the composer behind it.
      if (
        composerElement.querySelector(OPEN_COMPOSER_OVERLAY_TRIGGER_SELECTOR)
      ) {
        return;
      }
      setIsComposerFocused(false);
    }, COMPOSER_COLLAPSE_SETTLE_MS);
  }, [cancelPendingFocusLoss]);
  useEffect(() => cancelPendingFocusLoss, [cancelPendingFocusLoss]);
  const compactConfig = useMemo(
    () =>
      isCompactViewport
        ? {
            isCompact: isMobilePromptBoxCompact,
            placeholder: composer.compactPromptPlaceholder,
          }
        : undefined,
    [
      composer.compactPromptPlaceholder,
      isCompactViewport,
      isMobilePromptBoxCompact,
    ],
  );
  const steerOnPrimarySubmit =
    submitMode.kind === "queue" && composer.steerActiveThreadOnEnter;
  const onPrimarySubmit = steerOnPrimarySubmit
    ? composer.onModifierSubmit
    : composer.onSubmit;
  const onModifierSubmit = composer.canModifierSubmit
    ? steerOnPrimarySubmit
      ? composer.onSubmit
      : composer.onModifierSubmit
    : undefined;
  const executionControlsDisabled = executionReadOnly ?? readOnly ?? false;
  const footerStart = useMemo(
    () => (
      <ExecutionControls {...execution} disabled={executionControlsDisabled} />
    ),
    [execution, executionControlsDisabled],
  );
  const promptModeInput = useMemo(
    () => ({
      providerId: execution.provider.selectedId,
      value: composer.message,
      mentionRanges: composer.mentionRanges,
    }),
    [composer.mentionRanges, composer.message, execution.provider.selectedId],
  );
  const permissionDisplayOverride = useMemo(
    () =>
      permissionDisplayForActivePromptMode(activePromptMode) ??
      permissionDisplayForPromptMode(promptModeInput),
    [activePromptMode, promptModeInput],
  );
  const permissionPickerDisabledByPlanMode =
    shouldDisablePermissionPickerForActivePromptMode(activePromptMode) ||
    shouldDisablePermissionPickerForPromptMode(promptModeInput);
  const permissionReadOnlyResolved = permissionReadOnly ?? readOnly ?? false;
  const permissionPickerDisabled =
    permissionReadOnlyResolved || permissionPickerDisabledByPlanMode;
  // Side chat and active plan mode render the same permission picker as the
  // main thread, but non-interactive so the displayed effective mode cannot
  // diverge from the provider mode driving the current turn.
  const permissionControl = useMemo(
    () => (
      <PermissionModePicker
        value={permission.value}
        options={permission.options}
        onChange={permission.onChange}
        supported={permission.supported}
        disabled={permissionPickerDisabled}
        showChevronWhenDisabled={permissionPickerDisabledByPlanMode}
        displayOverride={permissionDisplayOverride}
        className="h-6"
      />
    ),
    [
      permission.onChange,
      permission.options,
      permission.supported,
      permission.value,
      permissionDisplayOverride,
      permissionPickerDisabledByPlanMode,
      permissionPickerDisabled,
    ],
  );
  const stackRef = useRef<HTMLDivElement>(null);
  const lastStackHeightRef = useRef(0);
  const [stackHeight, setStackHeight] = useState(0);
  const applyStackHeight = useCallback((measured: number) => {
    if (lastStackHeightRef.current === measured) return;
    lastStackHeightRef.current = measured;
    setStackHeight(measured);
  }, []);

  // Take one initial border-box measurement before paint. Later measurements
  // use ResizeObserver's supplied border-box size, which avoids a synchronous
  // offsetHeight read after each timeline or composer render.
  useLayoutEffect(() => {
    const element = stackRef.current;
    if (element) {
      applyStackHeight(element.offsetHeight);
    }
  }, [applyStackHeight]);

  useEffect(() => {
    const element = stackRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === element);
      if (!entry) return;
      const borderBoxSize = Array.isArray(entry.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry.borderBoxSize;
      applyStackHeight(borderBoxSize?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [applyStackHeight]);
  // The elastic pre-size keeps the prompt area's total height constant as the
  // stack (context banner + queued messages) mounts/unmounts so the timeline
  // doesn't shift. Callers that need the main-thread prompt height should pass
  // an empty stack instead of null.
  const elasticTextareaMinHeight =
    stack === null
      ? FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT
      : Math.max(
          FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT,
          FOLLOW_UP_PROMPT_BOX_ELASTIC_TARGET_HEIGHT - stackHeight,
        );

  const composerElement = (
    <div
      ref={composerInteractionRef}
      className="relative z-20"
      data-follow-up-composer=""
      data-follow-up-composer-expanded={
        !isMobilePromptBoxCompact ? "" : undefined
      }
      onFocusCapture={handleComposerFocus}
      onBlurCapture={handleComposerBlur}
    >
      <PromptBoxWithScrollAnchor
        id={id}
        promptBoxRef={promptBoxRef}
        voice={voice}
        minHeight={elasticTextareaMinHeight}
        value={composer.message}
        mentionRanges={composer.mentionRanges}
        onChange={composer.onChangeMessage}
        onSubmit={onPrimarySubmit}
        blurOnPointerSubmit={isCompactViewport && isPointerCoarse}
        textEffects={textEffects}
        onComposerLayoutChange={setComposerLayout}
        scrollToBottomOnSubmit={
          submitMode.kind !== "queue" || steerOnPrimarySubmit
        }
        scrollToBottomOnModifierSubmit={!steerOnPrimarySubmit}
        history={composer.history}
        focusEndKey={focusEndKey}
        placeholder={composer.promptPlaceholder}
        containerCompactPlaceholder={composer.compactPromptPlaceholder}
        mentionMenuPlacement="top"
        submission={{
          onStop: onStopRuntime,
          isSubmitting: composer.isFollowUpSubmitting || isStopping,
          disabled:
            !canSubmit ||
            composer.isFollowUpSubmitting ||
            (steerOnPrimarySubmit && !composer.canModifierSubmit),
          onModifierSubmit,
          title: composer.isFollowUpSubmitting
            ? "Submitting..."
            : canSubmit && composer.submitTitle !== undefined
              ? composer.submitTitle
              : canQueueFollowUp
                ? steerOnPrimarySubmit
                  ? "Steer current run (Enter)"
                  : "Queue follow-up (Enter)"
                : isStopping
                  ? "Stopping run..."
                  : isLoadingExecutionOptions
                    ? "Loading models..."
                    : isLoadingPendingInteractions
                      ? "Checking pending interactions..."
                      : isProvisioning
                        ? "Provisioning..."
                        : isUnavailable
                          ? "Unavailable"
                          : "Submit (Enter)",
          isRunning: canStopRuntime,
        }}
        typeahead={typeahead}
        attachments={attachments}
        promptActions={promptActions}
        suppressPluginComposerCustomizations={
          suppressPluginComposerCustomizations
        }
        compact={compactConfig}
        zenMode={{
          layout: "thread",
          storageKey: null,
          resetKey: `${zenModeResetKey}:${
            isCompactViewport ? "mobile" : "desktop"
          }`,
          resetOnSubmit: true,
        }}
        footerStart={footerStart}
      />
      {!isMobilePromptBoxCompact ? (
        <div
          data-follow-up-composer-footer=""
          className="mt-1 flex min-h-6 max-h-6 items-center justify-between gap-2 overflow-hidden pl-[15px] pr-3.5 opacity-100 transition-[max-height,min-height,margin-top,opacity] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {environmentSummary}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {permissionControl}
            {contextWindowUsage ? (
              <ThreadContextWindowIndicator usage={contextWindowUsage} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <PluginComposerViewProvider value={composerView}>
      <PluginComposerHostProvider value={pluginComposerHost ?? null}>
        <>
          {showScrollToBottomButton ? (
            <ThreadTimelineScrollToBottomButton
              active={composer.threadRuntimeDisplayStatus === "active"}
            />
          ) : null}
          <div
            data-app-composer=""
            data-app-composer-role={isPrimaryComposer ? "primary" : "secondary"}
            data-promptbox-shell=""
            className="space-y-2"
          >
            <div ref={stackRef} className="grid gap-2">
              {composerScope ? <PluginComposerBanners /> : null}
              {stack}
            </div>
            <div data-follow-up-composer-anchor="">{composerElement}</div>
          </div>
        </>
      </PluginComposerHostProvider>
    </PluginComposerViewProvider>
  );
}

export const FollowUpPromptBox = memo(function FollowUpPromptBox(
  props: FollowUpPromptBoxProps,
) {
  if (props.composer === null) {
    return (
      <FollowUpPromptBoxStackOnly
        stack={props.stack}
        pluginComposerHost={props.pluginComposerHost}
        pluginComposerScope={props.pluginComposerScope}
      />
    );
  }
  return <FollowUpPromptBoxWithComposer {...props} composer={props.composer} />;
});
