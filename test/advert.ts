// test/advert.ts

import { AdvMode, BleuIO } from '../src/BleuIO'

async function main() {
    const dongle = await BleuIO.open('COM19')

    try {
        await dongle.setPeripheral({ name: 'BJ' })

        await dongle.startAdvertising({
            mode: AdvMode.NON_CONNECTABLE,
            intervalMs: 20,
            durationSec: 0,
            name: 'BJ',
            clear: true
        })

        console.log('advertising... press Ctrl+C to stop')

        process.on('SIGINT', async () => {
            await dongle.stopAdvertising()
            await dongle.close()
            process.exit(0)
        })

        await new Promise(() => { })
    }
    finally {
        await dongle.close()
    }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})