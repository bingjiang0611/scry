export const defaultOrder = ['input', 'working', 'completed']

export function initialState() {
  return {
    order: [...defaultOrder],
    selected: 'webhook',
    tasks: [
      { id: 'onboarding', group: 'input' },
      { id: 'grid', group: 'working' },
      { id: 'server', group: 'working' },
      { id: 'checkout', group: 'working' },
      { id: 'webhook', group: 'completed' },
      { id: 'theme', group: 'completed' }
    ]
  }
}

export function transition(state, action) {
  if (action === 'reset') return initialState()
  if (action === 'groups') {
    return { ...state, order: [state.order[1], state.order[0], state.order[2]] }
  }
  if (action === 'reorder') {
    const working = state.tasks.filter(task => task.group === 'working').reverse()
    let index = 0
    return { ...state, tasks: state.tasks.map(task => task.group === 'working' ? working[index++] : task) }
  }
  const [id, group] = {
    resume: ['onboarding', 'working'],
    input: ['checkout', 'input'],
    complete: ['grid', 'completed']
  }[action]
  return { ...state, tasks: [{ id, group }, ...state.tasks.filter(task => task.id !== id)] }
}

export function visibleItems(state, query, labels) {
  const matching = state.tasks.filter(task => labels[task.id].toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return state.order.flatMap(group => {
    const tasks = matching.filter(task => task.group === group)
    return tasks.length ? [{ key: `group-${group}`, group, heading: true }, ...tasks.map(task => ({ ...task, key: task.id }))] : []
  })
}
