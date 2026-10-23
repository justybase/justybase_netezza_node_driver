// Child process hosting the replay server so its CPU work stays out of the
// benchmarked event loop. Reports the listening port over IPC.
const { loadBenchFixture } = require('./fixtures');
const { NzReplayServer } = require('../../tests/helpers/replay/NzReplayServer');

(async () => {
    const server = await new NzReplayServer(loadBenchFixture(process.argv[2])).start();
    process.send({ port: server.port });
    process.on('disconnect', () => server.stop().finally(() => process.exit(0)));
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
