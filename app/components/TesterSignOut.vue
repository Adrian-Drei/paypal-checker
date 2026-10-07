<script setup lang="ts">
defineProps<{ disabled?: boolean }>()
const busy = ref(false)
const error = ref('')
async function signOut() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await $fetch('/api/paypal/logout', { method: 'POST', retry: 0 })
    await navigateTo('/sign-in', { replace: true })
  } catch { error.value = 'Unable to sign out. Please try again.' }
  finally { busy.value = false }
}
</script>

<template>
  <div class="mb-5 text-right">
    <button :disabled="disabled || busy" class="text-sm font-semibold text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-blue-700 disabled:opacity-50" @click="signOut">{{ busy ? 'Signing out…' : 'Sign out' }}</button>
    <p v-if="error" role="alert" class="mt-2 text-sm text-red-700">{{ error }}</p>
  </div>
</template>
