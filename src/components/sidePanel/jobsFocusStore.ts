/**
 * jobsFocusStore：Chat → JobsPanelAdapter 的聚焦请求通道（任务卡片点击
 * 打开面板时要聚焦到对应任务）。刻意做成 module-level 三行 store，而不是
 * 塞进 PanelStore（那是 badge/注册表的家，不背业务状态）或
 * SidePanelRuntimeContext（useSidePanel 不该知道 jobs 的业务）。
 *
 * 写：Chat 在 openPanel('jobs') 前调 request(id)；读：Adapter 经
 * useSyncExternalStore 拿 { id, nonce }，nonce 保证同一 id 的重复请求
 * （再次点击同一张卡）也能重新触发聚焦。
 */

export interface JobsFocusRequest {
    readonly id: string | null
    readonly nonce: number
}

let snapshot: JobsFocusRequest = Object.freeze({ id: null, nonce: 0 })
const listeners = new Set<() => void>()

function emit(): void {
    for (const listener of [...listeners]) listener()
}

export const jobsFocusStore = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
    },
    get(): JobsFocusRequest {
        return snapshot
    },
    /** 请求聚焦某个任务（id=null 只推进 nonce，不触发聚焦）。 */
    request(id: string | null): void {
        snapshot = Object.freeze({ id, nonce: snapshot.nonce + 1 })
        emit()
    },
}
