<script setup lang="ts">
const props = defineProps<{
  open: boolean
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const dialog = ref<HTMLDialogElement>()
const titleId = useId()
const descriptionId = useId()
let previousOverflow: string | undefined

function unlockScroll() {
  if (previousOverflow !== undefined) {
    document.body.style.overflow = previousOverflow
    previousOverflow = undefined
  }
}

watch(() => props.open, async (open) => {
  await nextTick()
  if (open && props.open && dialog.value && !dialog.value.open) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Native modal dialogs provide focus trapping, inert background, and focus restoration.
    dialog.value.showModal()
  } else if (!props.open) {
    dialog.value?.close()
    unlockScroll()
  }
}, { immediate: true })

onBeforeUnmount(unlockScroll)
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" :aria-labelledby="titleId" :aria-describedby="descriptionId" class="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/50 backdrop:backdrop-blur-sm" @cancel.prevent="emit('cancel')" @click.self="emit('cancel')">
      <div class="p-6 sm:p-8">
        <div class="mb-5 flex size-12 items-center justify-center rounded-full" :class="danger ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'" aria-hidden="true">
          <svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v4m0 4h.01" /></svg>
        </div>
        <h2 :id="titleId" class="text-xl font-bold tracking-tight">{{ title }}</h2>
        <p :id="descriptionId" class="mt-3 text-sm leading-6 text-slate-600">{{ description }}</p>
        <div class="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button autofocus type="button" class="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600" @click="emit('cancel')">Cancel</button>
          <button type="button" class="rounded-lg px-4 py-2.5 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2" :class="danger ? 'bg-red-700 hover:bg-red-800 focus-visible:outline-red-600' : 'bg-blue-700 hover:bg-blue-800 focus-visible:outline-blue-600'" @click="emit('confirm')">{{ confirmLabel }}</button>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>
