<script setup lang="ts">
const broken = ref(false);

function reserveSlot(slotId: number) {
    throw new Error(`Slot ${slotId} was taken before checkout finished`);
}

function clickError() {
    console.warn('about to reserve a slot', { slot: 4 });
    reserveSlot(4);
}

async function callBoom() {
    await $fetch('/api/boom').catch(() => {});
}

function manual() {
    try {
        JSON.parse('{ not json');
    } catch (error) {
        captureException(error);
    }
}
</script>

<template>
    <h1>Magpie Nuxt playground</h1>
    <button id="click-error" @click="clickError">Throw in a click handler</button>
    <button id="boom" @click="callBoom">Call a failing API route</button>
    <button id="manual" @click="manual">Captured by hand</button>
    <button id="render-error" @click="broken = true">Break a component</button>
    <p v-if="broken">{{ (null as any).missing.deep }}</p>
</template>
