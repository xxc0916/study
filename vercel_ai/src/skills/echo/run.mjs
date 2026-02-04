export async function run(input) {
  const text = input?.text;
  if (typeof text !== 'string') throw new Error('echo 需要输入 { text: string }');
  return { text };
}

