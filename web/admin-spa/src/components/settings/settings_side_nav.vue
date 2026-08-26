<template>
  <!-- 设置侧栏：PC 竖栏固定 / 移动端顶栏横滑；样式走主题工具类 -->
  <div class="settings-side-nav shrink-0 md:flex md:h-full md:flex-col">
    <div class="t-side-nav-mobile flex md:hidden">
      <router-link
        v-for="tab in tabs"
        :key="tab.key"
        class="t-side-nav-mobile__item"
        :class="{ 'is-active': modelValue === tab.key }"
        :to="{ name: 'Settings', params: { section: tab.key } }"
      >
        <i v-if="tab.icon" class="text-sm" :class="tab.icon" />
        {{ tab.label }}
      </router-link>
    </div>

    <nav
      class="t-side-nav custom-scrollbar hidden h-full w-44 shrink-0 flex-col overflow-y-auto border-r pr-3 md:flex"
      style="border-color: var(--divider-color)"
    >
      <router-link
        v-for="tab in tabs"
        :key="tab.key"
        class="t-side-nav__item"
        :class="{ 'is-active': modelValue === tab.key }"
        :to="{ name: 'Settings', params: { section: tab.key } }"
      >
        <span class="t-side-nav__icon">
          <i v-if="tab.icon" :class="tab.icon" />
        </span>
        <span class="t-side-nav__label">{{ tab.label }}</span>
      </router-link>
    </nav>
  </div>
</template>

<script setup>
// tabs: [{ key, label, icon? }]
defineProps({
  modelValue: { type: String, default: '' },
  tabs: { type: Array, default: () => [] }
})
</script>
