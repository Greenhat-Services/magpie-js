import * as Magpie from '@greenhat-services/magpie-vue';
import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Home from './Home.vue';
import User from './User.vue';

const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: '/', component: Home },
        { path: '/users/:id', component: User },
    ],
});

const app = createApp(App);

Magpie.init({
    app,
    router,
    dsn: import.meta.env.VITE_MAGPIE_DSN,
    release: import.meta.env.VITE_MAGPIE_RELEASE,
    environment: 'playground',
    tracesSampleRate: 1,
    tracePropagationTargets: ['magpie.test'],
});

app.use(router).mount('#app');
