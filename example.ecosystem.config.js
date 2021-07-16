module.exports = {
    apps : [
        {
            name   : "Status Monitor",
            namespace: "kanmi-10",
            script : "./index.js",
            watch: ['js'],
            watch_delay: 1000,
            args   : "",
            instances: 1,
            cron_restart: '16 3 * * *',
            stop_exit_codes: [0],
            restart_delay: 5000,
            kill_timeout : 3000,
            exp_backoff_restart_delay: 100,
            wait_ready: true,
            env: {
                NODE_ENV: 'production'
            },
            env_production: {
                NODE_ENV: 'production'
            }
        }
    ]
}