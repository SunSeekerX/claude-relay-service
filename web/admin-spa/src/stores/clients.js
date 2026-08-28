import { defineStore } from 'pinia'
import { getSupportedClientsApi } from '@/libs/http_apis'
import { isOk, msgOf } from '@/libs/http_envelope'

export const useClientsStore = defineStore('clients', {
  state: () => ({
    supportedClients: [],
    loading: false,
    error: null
  }),

  actions: {
    async loadSupportedClients() {
      if (this.supportedClients.length > 0) return this.supportedClients

      this.loading = true
      const res = await getSupportedClientsApi()
      if (isOk(res)) this.supportedClients = res.data || []
      else this.error = msgOf(res)
      this.loading = false
      return this.supportedClients
    }
  }
})
