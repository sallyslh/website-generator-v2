// Runs before every test file: the image library uses one thread, so the tests also pass on a machine that is short of memory.
process.env.VIPS_CONCURRENCY ??= '1';
// the picture editor costs money: tests only use it through a fake (deps.editImage)
process.env.IMAGE_EDITING = 'off';
