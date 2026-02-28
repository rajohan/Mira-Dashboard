import axios from 'axios';

const OPENCLAW_URL = import.meta.env.VITE_OPENCLAW_URL || '';
const OPENCLAW_TOKEN = import.meta.env.VITE_OPENCLAW_TOKEN || new URLSearchParams(window.location.search).get('token');

export const apiClient = axios.create({
  baseURL: `${OPENCLAW_URL}/api/v1`,
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('openclaw_token') || OPENCLAW_TOKEN;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('openclaw_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default apiClient;
