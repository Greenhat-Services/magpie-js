<script setup lang="ts">
const route = useRoute();
const { data } = await useFetch('/api/user', { query: { id: route.params.id } });
</script>

<template>
    <h1 id="user">User {{ route.params.id }}: {{ data?.name }}</h1>
</template>
