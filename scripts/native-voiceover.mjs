export async function withVoiceOverActivation(
  { read, toggle, wait, ready },
  action,
) {
  const initial = await read();
  try {
    if (!(await ready())) {
      if (!initial) {
        await toggle();
        await wait(true);
      }
      if (!(await ready()))
        throw new Error("AX controls unavailable after VoiceOver activation");
    }
    return await action();
  } finally {
    if ((await read()) !== initial) {
      await toggle();
      await wait(initial);
    }
  }
}
