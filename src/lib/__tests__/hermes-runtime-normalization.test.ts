import { describe, expect, it } from 'vitest'
import { extractHermesAction, normalizeHermesResponse } from '@/lib/hermes-runtime'

describe('Hermes response normalization', () => {
  it('classifies reasoning-only responses as incomplete', () => {
    expect(normalizeHermesResponse({ message: { role: 'assistant', content: '', reasoning: 'planning' } })).toMatchObject({ content: null, reasoning: 'planning', toolCallState: 'reasoning_only' })
  })

  it('normalizes an OpenAI-compatible choices tool call without exposing reasoning', () => {
    expect(normalizeHermesResponse({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', reasoning_content: 'hidden plan', tool_calls: [{ function: { name: 'SAVE_WORKING_MEMORY', arguments: '{"title":"T","content":"C","memory_type":"operational_note"}' } }] } }] })).toMatchObject({
      content: '<tool_call>{"name":"SAVE_WORKING_MEMORY","arguments":{"title":"T","content":"C","memory_type":"operational_note"}}</tool_call>',
      reasoning: 'hidden plan',
      finishReason: 'tool_calls',
      toolCallState: 'structured',
    })
  })

  it('accepts the standard JSON action envelope', () => {
    expect(extractHermesAction('<tool_call>{"name":"SAVE_WORKING_MEMORY","arguments":{"title":"T","content":"C","memory_type":"operational_note"}}</tool_call>')).toEqual({ action: 'SAVE_WORKING_MEMORY', parameters: { title: 'T', content: 'C', memory_type: 'operational_note' } })
  })

  it('normalizes Hermes DSML action output', () => {
    const dsml = '<｜DSML｜tool_call>\n<｜DSML｜parameter name="title" string="true">COO acceptance disposable</｜DSML｜parameter>\n<｜DSML｜parameter name="priority" string="true">low</｜DSML｜parameter>\n<｜DSML｜parameter name="action" string="true">CREATE_TASK</｜DSML｜parameter>\n<｜DSML｜tool_call>'
    expect(extractHermesAction(dsml)).toEqual({ action: 'CREATE_TASK', parameters: { title: 'COO acceptance disposable', priority: 'low' } })
  })

  it('normalizes DSML invoke actions with JSON arguments', () => {
    const dsml = '<｜DSML｜tool_call><｜DSML｜parameter name="name" string="true">SAVE_WORKING_MEMORY</｜DSML｜parameter><｜DSML｜parameter name="arguments" string="true">{"title":"T","content":"C","memory_type":"product_context"}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_call>'
    expect(extractHermesAction(dsml)).toEqual({ action: 'SAVE_WORKING_MEMORY', parameters: { title: 'T', content: 'C', memory_type: 'product_context' } })
  })

  it('keeps task project binding server-owned while mapping provider aliases', () => {
    expect(extractHermesAction('<｜DSML｜tool_call><｜DSML｜parameter name="name" string="true">CREATE_TASK</｜DSML｜parameter><｜DSML｜parameter name="arguments" string="true">{"title":"T","description":"D","project_id":999,"status":"pending","task_type":"test"}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_call>')).toEqual({ action: 'CREATE_TASK', parameters: { title: 'T', objective: 'D' } })
  })
})
