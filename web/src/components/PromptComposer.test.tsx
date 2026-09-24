// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import PromptComposer from './PromptComposer'

afterEach(cleanup)

describe('PromptComposer chat behavior', () => {
  it('sends the message with Enter', async () => {
    const user = userEvent.setup()
    let sent = ''
    render(
      <PromptComposer
        runId="run-1"
        busy={false}
        onSend={async (text) => {
          sent = text
        }}
      />,
    )

    await user.type(screen.getByRole('textbox'), '帮我检查项目{Enter}')

    expect(sent).toBe('帮我检查项目')
  })
})
