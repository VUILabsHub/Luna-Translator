// Match physical endpoints, never the browser's default/communications aliases.
export function showcaseDemoOutputs(devices: { deviceId: string; label: string }[]) {
  const physical = devices.filter(device => device.deviceId !== 'default' && device.deviceId !== 'communications')
  const external = physical.find(device => /外置耳机\s*\(Built-in\)/i.test(device.label))
  const inzone = physical.find(device => /\bINZONE\s+H3\s*\(054c:0e47\)/i.test(device.label))
  return external && inzone ? { external, inzone } : undefined
}
