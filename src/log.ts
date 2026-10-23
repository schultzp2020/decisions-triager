// Structured logging to stderr, one line per event, mirroring the Python
// triager's logging.basicConfig format.
function write(level: string, message: string): void {
  const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  process.stderr.write(`${stamp} ${level} triager ${message}\n`);
}

export const log = {
  info: (message: string) => write("INFO", message),
  warn: (message: string) => write("WARNING", message),
  error: (message: string) => write("ERROR", message),
};
