<script setup lang="ts">
import SelectField from '../fields/SelectField.vue'
import TextField from '../fields/TextField.vue'

const LEVELS = [
  { value: '1', label: 'Large' },
  { value: '2', label: 'Medium' },
  { value: '3', label: 'Small' },
]
</script>

<template>
  <TextField path="text" label="Text" />
  <SelectField path="level" label="Size" :options="LEVELS" numeric />
</template>
