import { AdvMode, BleuIO } from '../src/BleuIO'

async function main() {
    const dongle = await BleuIO.open('COM19')

    try {
        await dongle.ate(false)
        await dongle.at_peripheral()

        await dongle.at_advstop()
        await dongle.at_advdata('03:09:42:4A')

        await dongle.at_advstart({
            mode: AdvMode.CONNECTABLE_UNDIRECTED,
            intervalMs: 20,
            durationSec: 0
        })

        console.log('advertising...')
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