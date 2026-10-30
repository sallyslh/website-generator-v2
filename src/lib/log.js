// Simple console logger that prefixes every line with the stage name.

export const log = {
  info(stage, message) {
    console.log(`[${stage}] ${message}`);
  },
  error(stage, message) {
    console.error(`[${stage}] ERROR: ${message}`);
  },
};
