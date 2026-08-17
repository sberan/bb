import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { WaveformVisualizer } from "./WaveformVisualizer.js";

interface VoiceRecordingBarProps {
  state: "recording" | "transcribing";
  stream: MediaStream | null;
  /** Transcribe into the composer and stop there, leaving the text editable. */
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * Transcribe and submit in one action, so a spoken message costs two taps
   * instead of three. Omitted when there is nothing to submit to, in which case
   * only the insert action is shown.
   */
  onConfirmAndSend?: () => void;
  /**
   * Label for the send action. A busy thread queues rather than interrupting,
   * so the control says which one will happen instead of always saying "send".
   */
  sendLabel?: string;
}

const CONTROL_BUTTON_CLASS =
  "size-8 rounded-full p-0 max-md:pointer-coarse:size-10";

export function VoiceRecordingBar({
  state,
  stream,
  onConfirm,
  onCancel,
  onConfirmAndSend,
  sendLabel = "Send",
}: VoiceRecordingBarProps) {
  const isTranscribing = state === "transcribing";
  // The stream only exists once getUserMedia has resolved, so it is the honest
  // signal that the microphone is actually capturing rather than still being
  // granted or opened.
  const isLive = state === "recording" && stream !== null;

  return (
    <div className="flex flex-row items-center gap-2 px-2 py-1.5">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={
          isTranscribing ? "Cancel transcription" : "Cancel recording"
        }
        onClick={onCancel}
        className={CONTROL_BUTTON_CLASS}
      >
        <Icon name="X" className="size-4" />
      </Button>
      <div className="relative flex min-w-0 flex-1 items-center gap-2">
        {/* The waveform is flat until it hears something, so it cannot
            distinguish "still acquiring the microphone" from "listening, say
            something". Permission prompts and device start-up make that gap
            long enough to be confusing. This says which state you are in
            without waiting for audio. */}
        {!isTranscribing ? (
          <span
            className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
            data-voice-ready={isLive ? "" : undefined}
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                isLive
                  ? "animate-pulse bg-destructive"
                  : "bg-muted-foreground/40",
              )}
            />
            {isLive ? "Listening" : "Starting"}
          </span>
        ) : null}
        <div
          className={cn("h-7 min-w-0 flex-1", isTranscribing && "animate-shine-icon")}
        >
          <WaveformVisualizer stream={stream} active={!isTranscribing} />
        </div>
        <span className="sr-only" aria-live="polite">
          {isTranscribing
            ? "Transcribing"
            : isLive
              ? "Microphone ready, listening"
              : "Starting microphone"}
        </span>
      </div>
      {/* Insert and send sit side by side so the common case (say it, send it)
          is one tap, while a message worth proofreading is still one tap to
          drop into the composer. */}
      <Button
        type="button"
        size="icon"
        variant={onConfirmAndSend ? "ghost" : "default"}
        aria-label={
          isTranscribing
            ? "Transcribing voice input"
            : "Stop and transcribe recording"
        }
        disabled={isTranscribing}
        onClick={onConfirm}
        className={CONTROL_BUTTON_CLASS}
      >
        {isTranscribing ? (
          <Icon name="Spinner" className="size-4 animate-spin" />
        ) : (
          <Icon name="Check" className="size-4" />
        )}
      </Button>
      {onConfirmAndSend ? (
        <Button
          type="button"
          size="icon"
          variant="default"
          aria-label={
            isTranscribing ? "Transcribing voice input" : sendLabel
          }
          disabled={isTranscribing}
          onClick={onConfirmAndSend}
          className={CONTROL_BUTTON_CLASS}
        >
          <Icon name="ArrowUp" className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}
