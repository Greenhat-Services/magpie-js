export default defineEventHandler(async (event) => {
    const { id } = getQuery(event);
    // A call to another service: it should become a span, and carry the trace on to that service.
    await fetch('http://127.0.0.1:4173/').catch(() => {});

    return { id, name: `Customer ${id}` };
});
