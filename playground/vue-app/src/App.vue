<script setup lang="ts">
</script>

<template>
    <nav>
        <router-link to="/">Home</router-link> |
        <router-link to="/users/7" id="to-user">User 7</router-link>
    </nav>
    <router-view />
</template>
