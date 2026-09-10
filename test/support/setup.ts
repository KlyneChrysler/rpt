// Auto-starting the collector daemon is correct in production and wrong in a
// test run: every suite that drives a hook would spawn a real detached process
// that outlives the run, against a fixture repository in the OS temp directory.
// Suites that mean to exercise the auto-start path clear this themselves.
process.env.RPT_NO_DAEMON = "1";
