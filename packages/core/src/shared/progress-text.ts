const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;

export const formatDuration = (milliseconds: number): string => {
  const wholeSeconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
  const seconds = Math.max(0, wholeSeconds);
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);

  const minutesText = String(minutes).padStart(2, "0");
  const secondsText = String(seconds % SECONDS_PER_MINUTE);
  return `${minutesText}:${secondsText.padStart(2, "0")}`;
};

export const progressText = (message: string): string => {
  const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/gu;
  const sanitizedMessage = message.replace(controlCharacters, " ");
  return sanitizedMessage.trim();
};
