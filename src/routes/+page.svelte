<script lang="ts">
  import DesktopApp from "$lib/desktop/DesktopApp.svelte";
  import MobileApp from "$lib/mobile/MobileApp.svelte";

  const isDesktop = import.meta.env.VITE_REDTERM_TARGET === "desktop";
</script>

{#if isDesktop}
  <DesktopApp />
{:else}
  <MobileApp />
{/if}
