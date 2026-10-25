export interface Turn {
  id: string | null;
  controller: AbortController;
  ended: boolean;
}

// 每个对话只保留当前回合。异步结果必须仍属于当前对象才能发布。
export class Turns {
  private current = new Map<string, Turn>();
  start(agentId: string, id: string | null): Turn {
    this.remove(agentId);
    const turn = { id, controller: new AbortController(), ended: false };
    this.current.set(agentId, turn);
    return turn;
  }
  end(agentId: string, id: string | null): Turn | null {
    const turn = this.current.get(agentId) ?? this.start(agentId, id);
    if (turn.id !== id || turn.ended) return null;
    turn.ended = true;
    return turn;
  }
  isCurrent(agentId: string, turn: Turn): boolean {
    return this.current.get(agentId) === turn && !turn.controller.signal.aborted;
  }
  remove(agentId: string): void {
    this.current.get(agentId)?.controller.abort();
    this.current.delete(agentId);
  }
  clear(): void {
    for (const id of this.current.keys()) this.remove(id);
  }
}
