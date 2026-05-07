// test/scanReq.ts

import { BleuIO } from '../src/BleuIO'

const EMS_ADDR = 'AA:AA:AA:AA:AA:AA'

async function main() {
    const central = await BleuIO.open('COM18')

    try {
        await central.setCentral()

        console.log(await central.at_scanparam({
            scanMode: 2,
            scanType: 0,
            intervalMs: 100,
            windowMs: 100,
            filterDuplicates: false
        }))

        const t0 = Date.now()

        const hit = await central.scanUntilAddress(EMS_ADDR, {
            scanSeconds: 3
        })

        console.log('hit:', hit)
        console.log(`time(ms): ${Date.now() - t0}`)
    }
    finally {
        await central.close()
    }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
