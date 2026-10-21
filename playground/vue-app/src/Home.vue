<script setup lang="ts">
import { ref } from 'vue';
import * as Magpie from '@greenhat-services/magpie-vue';
import Broken from './Broken.vue';

const broken = ref(false);

function reserveSlot(slotId: number) {
    throw new Error(`Slot ${slotId} was taken before checkout finished`);
}

function clickError() {
    console.warn('about to reserve a slot', { slot: 4 });
    reserveSlot(4);
}

function rejection() {
    Promise.reject(new Error('Unhandled rejection from the playground'));
}

function lateError() {
    setTimeout(() => {
        const venue = null as unknown as { name: string };
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        venue.name;
    }, 0);
}

async function failingRequest() {
    await fetch('http://magpie.test/api/nothing-here?token=abc123');
    Magpie.captureMessage('request finished', 'info');
}

function manual() {
    try {
        JSON.parse('{ not json');
    } catch (error) {
        Magpie.captureException(error);
    }
}
</script>

<template>
    <h1>Magpie Vue playground</h1>
    <button id="click-error" @click="clickError">Throw in a click handler</button>
    <button id="rejection" @click="rejection">Unhandled rejection</button>
    <button id="late-error" @click="lateError">Uncaught error in a timer</button>
    <button id="failing-request" @click="failingRequest">Failing request</button>
    <button id="manual" @click="manual">Captured by hand</button>
    <button id="render-error" @click="broken = true">Break a component</button>
    <Broken v-if="broken" />
</template>
