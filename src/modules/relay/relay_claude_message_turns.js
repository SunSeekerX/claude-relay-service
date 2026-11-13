// Claude requires all parallel tool results in the next user turn, before other content.
export const mergeClaudeMessageTurns = (messages) => {
  const turns = []
  const blocks = (content) => (Array.isArray(content) ? content : [{ type: 'text', text: content }])
  for (const message of messages) {
    const previous = turns.at(-1)
    if (previous?.role === message?.role && ['assistant', 'user'].includes(message?.role)) {
      const content = blocks(previous.content)
      content.push(...blocks(message.content))
      turns[turns.length - 1] = { ...previous, ...message, content }
    } else {
      turns.push(
        message
          ? { ...message, content: Array.isArray(message.content) ? [...message.content] : message.content }
          : message,
      )
    }
  }
  for (const turn of turns) {
    if (turn?.role === 'user' && Array.isArray(turn.content)) {
      turn.content = [
        ...turn.content.filter((block) => block?.type === 'tool_result'),
        ...turn.content.filter((block) => block?.type !== 'tool_result'),
      ]
    }
  }
  return turns
}
