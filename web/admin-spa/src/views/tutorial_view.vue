<template>
  <div class="card p-3 sm:p-4">
    <div class="mb-3 sm:mb-4">
      <h3
        class="mb-2 flex items-center text-lg font-bold text-gray-900 dark:text-gray-100 sm:text-xl"
      >
        <i class="i-lucide-graduation-cap mr-2 text-blue-600" />
        {{ currentToolTitle }} 使用教程
      </h3>
      <p class="text-sm text-gray-600 dark:text-gray-400">
        跟着这个教程，你可以轻松在自己的电脑上安装并使用 {{ currentToolTitle }}。
      </p>
    </div>

    <!-- 系统选择标签 -->
    <div class="mb-3">
      <div class="flex flex-wrap gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
        <button
          v-for="system in tutorialSystems"
          :key="system.key"
          :class="[
            'flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold transition-all duration-300',
            activeTutorialSystem === system.key
              ? 'bg-white text-blue-600 shadow-sm dark:bg-blue-600 dark:text-white dark:shadow-blue-500/40'
              : 'text-gray-600 hover:bg-white/50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'
          ]"
          @click="activeTutorialSystem = system.key"
        >
          <i :class="system.icon" />
          {{ system.name }}
        </button>
      </div>
    </div>

    <!-- CLI 工具选择标签 -->
    <div class="mb-3 sm:mb-4">
      <div class="flex flex-wrap gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
        <button
          v-for="tool in cliTools"
          :key="tool.key"
          :class="[
            'flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold transition-all duration-300',
            activeCliTool === tool.key
              ? 'bg-white text-blue-600 shadow-sm dark:bg-blue-600 dark:text-white dark:shadow-blue-500/40'
              : 'text-gray-600 hover:bg-white/50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'
          ]"
          @click="activeCliTool = tool.key"
        >
          <i :class="tool.icon" />
          {{ tool.name }}
        </button>
      </div>
    </div>

    <!-- 动态组件 -->
    <component :is="currentTutorialComponent" :platform="activeTutorialSystem" />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import ClaudeCodeTutorial from '@/components/tutorial/claude_code_tutorial.vue'
import GeminiCliTutorial from '@/components/tutorial/gemini_cli_tutorial.vue'
import CodexTutorial from '@/components/tutorial/codex_tutorial.vue'
import DroidCliTutorial from '@/components/tutorial/droid_cli_tutorial.vue'
import GrokCliTutorial from '@/components/tutorial/grok_cli_tutorial.vue'

// 当前系统选择
const activeTutorialSystem = ref('windows')

// 当前 CLI 工具选择
const activeCliTool = ref('claude-code')

// 系统列表
const tutorialSystems = [
  { key: 'windows', name: 'Windows', icon: 'i-logos-microsoft-windows' },
  { key: 'macos', name: 'macOS', icon: 'i-logos-apple' },
  { key: 'linux', name: 'Linux / WSL2', icon: 'i-logos-linux-tux' }
]

// CLI 工具列表
const cliTools = [
  { key: 'claude-code', name: 'Claude Code', icon: 'i-lucide-bot', component: ClaudeCodeTutorial },
  { key: 'codex', name: 'Codex', icon: 'i-lucide-code', component: CodexTutorial },
  { key: 'gemini-cli', name: 'Gemini CLI', icon: 'i-logos-google-icon', component: GeminiCliTutorial },
  { key: 'droid-cli', name: 'Droid CLI', icon: 'i-lucide-terminal', component: DroidCliTutorial },
  { key: 'grok-cli', name: 'Grok / Codex', icon: 'i-lucide-zap', component: GrokCliTutorial }
]

// 当前工具标题
const currentToolTitle = computed(() => {
  const tool = cliTools.find((t) => t.key === activeCliTool.value)
  return tool ? tool.name : 'CLI 工具'
})

// 当前教程组件
const currentTutorialComponent = computed(() => {
  const tool = cliTools.find((t) => t.key === activeCliTool.value)
  return tool ? tool.component : null
})
</script>
