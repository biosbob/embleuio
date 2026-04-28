// test/scanUntil.ts

import { BleuIO } from '../src/BleuIO'

async function main() {
    const central = await BleuIO.open('COM18')

    try {
        await central.ate(false)
        await central.at_central()

        const t0 = Date.now()

        const hit = await central.scanUntilAddress('AA:AA:AA:AA:AA:AA', {
            scanSeconds: 3
        })

        const dt = Date.now() - t0

        console.log('hit:', hit)
        console.log(`time(ms): ${dt}`)
    }
    finally {
        await central.close()
    }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
