import { desktopConnectionLabel, refreshDesktopConnections, useDesktopConnections } from '../hooks/useDesktopConnections'
import './machine-navigation.css'

export function SavedRemoteHosts({ onOpen }: { onOpen: (connectionId: string) => void }): JSX.Element {
  const { connections, loaded, error } = useDesktopConnections()
  return <div className="saved-remote-hosts">
    {error && <div role="alert"><p>无法确认连接状态：{error}</p><button type="button" onClick={() => void refreshDesktopConnections()}>重试读取</button></div>}
    {!loaded && !error && <p className="machine-navigation__hint">正在读取主机…</p>}
    {loaded && !error && connections.length === 0 && <p className="machine-navigation__hint">尚未添加远程主机</p>}
    <ul aria-label="已保存的远程主机">
      {connections.map(connection => <li key={connection.id}>
        <button type="button" className="saved-remote-host" onClick={() => onOpen(connection.id)}>
          <span className="saved-remote-host__identity"><strong>{connection.label}</strong><small>{connection.ssh.username}@{connection.ssh.hostname}</small></span>
          <span className="saved-remote-host__state">{desktopConnectionLabel(connection, error)}</span>
        </button>
      </li>)}
    </ul>
  </div>
}

export function MachineNavigation({ targetId, onTarget, onOpen, onManage }: {
  targetId: string
  onTarget: (id: string) => void
  onOpen: (connectionId: string) => void
  onManage: () => void
}): JSX.Element {
  const { connections, error } = useDesktopConnections()
  const missing = targetId !== 'local' && !connections.some(connection => connection.id === targetId)
  return <section className="machine-navigation" aria-label="执行位置与远程主机">
    <label>新会话执行位置
      <select aria-label="新会话执行位置" value={targetId} onChange={event => onTarget(event.target.value)}>
        <option value="local">本机</option>
        {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.label} · {desktopConnectionLabel(connection, error)}</option>)}
        {missing && <option value={targetId}>远程连接不可用</option>}
      </select>
    </label>
    <div className="machine-navigation__heading"><span>远程主机</span><button type="button" onClick={onManage}>添加 / 管理</button></div>
    <SavedRemoteHosts onOpen={onOpen} />
  </section>
}
