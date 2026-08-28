<script lang="ts">
  import "$lib/styles/theme.css";
  import { onMount } from "svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";

  onMount(() => {
    settingsStore.applyAll();
  });
</script>

<slot />
