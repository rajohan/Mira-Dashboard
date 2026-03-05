import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
    content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
    theme: {
        extend: {
            colors: {
                primary: {
                    50: "#E7E9EE",
                    100: "#D4D8DF",
                    200: "#BFC5CF",
                    300: "#A7ADB8",
                    400: "#8A929E",
                    500: "#686F7B",
                    600: "#4A505A",
                    700: "#2A2D33",
                    800: "#1A1C20",
                    900: "#121316",
                    950: "#0B0B0C",
                },
                accent: {
                    50: "#EEF3FF",
                    100: "#DCE7FF",
                    200: "#B7CDFF",
                    300: "#8EAEFF",
                    400: "#6E96FF",
                    500: "#5B8CFF",
                    600: "#4D76E0",
                    700: "#3E5FB8",
                    800: "#2F4891",
                    900: "#22366E",
                    950: "#17244A",
                },
            },
        },
    },
    plugins: [typography],
};
