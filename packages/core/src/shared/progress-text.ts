export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export const progressText = (message: string): string => {
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
};
