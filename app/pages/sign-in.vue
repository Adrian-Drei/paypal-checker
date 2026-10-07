<script setup lang="ts">
useHead({ title: 'Tester sign in · PayPal checkout', meta: [{ name: 'robots', content: 'noindex, nofollow' }] })
const dialog = ref<HTMLDialogElement>()
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
let disposed = false

function open() { if (dialog.value && !dialog.value.open) dialog.value.showModal() }
async function signIn() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await $fetch('/api/paypal/login', { method: 'POST', body: { username: username.value, password: password.value }, retry: 0 })
    password.value = ''
    if (!disposed) await navigateTo('/', { replace: true })
  } catch (cause) {
    password.value = ''
    error.value = (cause as { data?: { statusMessage?: string } })?.data?.statusMessage ?? 'Unable to sign in. Please try again.'
  } finally { busy.value = false }
}
onMounted(open)
onBeforeUnmount(() => { disposed = true; password.value = ''; dialog.value?.close() })
</script>

<template>
  <main class="mx-auto flex min-h-dvh max-w-4xl flex-col justify-center px-6 py-16">
    <span class="text-sm font-semibold uppercase tracking-widest text-blue-700">Private tester workspace</span>
    <h1 class="mt-3 text-4xl font-bold tracking-tight">PayPal checkout test</h1>
    <p class="mt-4 max-w-lg leading-7 text-slate-600">Sign in with your tester account to access Sandbox and Live checkout testing.</p>
    <button class="mt-7 w-fit rounded-lg bg-blue-700 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600" @click="open">Sign in</button>
    <dialog ref="dialog" aria-labelledby="sign-in-title" aria-describedby="sign-in-description" class="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/50 backdrop:backdrop-blur-sm" @cancel="busy && $event.preventDefault()">
      <form class="p-6 sm:p-8" :aria-busy="busy" @submit.prevent="signIn">
        <div v-if="error" role="alert" class="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{{ error }}</div>
        <label for="tester-username" class="mt-6 block text-sm font-semibold">Username</label>
        <input id="tester-username" v-model="username" name="username" autocomplete="username" autofocus required maxlength="256" :disabled="busy" class="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:opacity-60">
        <label for="tester-password" class="mt-4 block text-sm font-semibold">Password</label>
        <input id="tester-password" v-model="password" name="password" type="password" autocomplete="current-password" required maxlength="4096" :disabled="busy" class="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:opacity-60">
        <div class="mt-7 flex gap-3">
          <button type="button" :disabled="busy" class="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50" @click="dialog?.close()">Cancel</button>
          <button type="submit" :disabled="busy" class="flex-1 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
        </div>
        <p class="mt-5 text-center text-xs text-slate-500">Authorized testers only · Session expires after 6 hours</p>
      </form>
    </dialog>
  </main>
</template>
