import { useState } from 'react'
import type { JSX } from 'react'
import { StartupPanel } from '@/components/startup/StartupPanel'
import { TasksPanel } from '@/components/startup/TasksPanel'
import { Rocker } from '@/components/instrument/rocker'

/*
 * 「开机在跑什么」这一页有两个来源，分两档看：
 *   · 开机自启 —— 三个 Run 键 + 两个启动文件夹（任务管理器里能看到的那份）
 *   · 计划任务 —— 任务计划程序里非微软自带的那一份
 *
 * 合成一页而不是新开一个侧栏项：两者回答的是同一个问题（「开机到底谁在跑」），
 * 而且经常要对着看 —— 一个软件往往两边都塞了东西。侧栏已经 5 项，再加一项的
 * 契约成本（导航、徽标、收起态、截图）换不来对应的信息增益。
 *
 * 两档各自的筛选与刷新按钮留在各自面板里：它们管的是自己那一份数据，
 * 提到这一层只会让 Tab 宿主变成一个什么都知道的大组件。
 */

type Tab = 'startup' | 'tasks'

const TAB_HINT: Record<Tab, string> = {
  startup: '注册表与启动文件夹里的开机自启项 —— 任务管理器里能看到的那份',
  tasks: '任务计划程序里非微软自带的任务 —— 定时联网、自动更新、遥测上报多半在这儿'
}

export function StartupView(): JSX.Element {
  const [tab, setTab] = useState<Tab>('startup')
  return (
    <div className="h-full min-h-0 overflow-auto p-4" data-testid="startup-view" data-tab={tab}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Rocker
            value={tab}
            onChange={setTab}
            aria-label="切换清单"
            options={[
              { value: 'startup', label: '开机自启', testId: 'tab-startup' },
              { value: 'tasks', label: '计划任务', testId: 'tab-tasks' }
            ]}
          />
          <span className="min-w-0 text-[11px] text-dim">{TAB_HINT[tab]}</span>
        </div>
        {/* 两档按需挂载：计划任务那份要起一次 COM 枚举（本机 1.5 秒），
            没点进来就不该替用户花这个时间 */}
        {tab === 'startup' ? <StartupPanel /> : <TasksPanel />}
      </div>
    </div>
  )
}
