/**
 * Composer slider for the frame-sampling interval.
 *
 * It posts the chosen interval to the Host route `/_dsh/video-eyes/interval`;
 * `read_video` reads that value on its next call, so a human choice applies
 * without the model having to guess or repeat a parameter.
 */
window.__ModuleLoader__.load({
  id: 'dsh-video-eyes',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/_dsh/video-eyes/interval'

    function IntervalSlider() {
      const [state, setState] = React.useState(null)
      const [offline, setOffline] = React.useState(false)
      const timer = React.useRef(null)

      React.useEffect(() => {
        let cancelled = false
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error('offline'))))
          .then((payload) => {
            if (cancelled || !payload || !payload.ok) return
            setState(payload)
            setOffline(false)
          })
          .catch(() => {
            if (!cancelled) setOffline(true)
          })
        return () => {
          cancelled = true
          if (timer.current) clearTimeout(timer.current)
        }
      }, [])

      const push = React.useCallback((value) => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ interval: value }),
          }).catch(() => {})
        }, 180)
      }, [])

      if (offline || !state) {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '2px 12px 6px',
              fontSize: 11,
              opacity: 0.55,
              color: 'inherit',
            },
          },
          '视频抽帧间隔：插件未连接',
        )
      }

      const interval = Number(state.interval ?? 0.5)
      const min = Number(state.min ?? 0.1)
      const max = Number(state.max ?? 10)
      const isCustom = state.runtime !== null && state.runtime !== undefined

      const onChange = (event) => {
        const value = Number(event.target.value)
        setState((prev) => ({ ...prev, interval: value, runtime: value }))
        push(value)
      }

      const reset = () => {
        setState((prev) => ({ ...prev, interval: state.configured, runtime: null }))
        push(0)
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '2px 12px 6px',
            fontSize: 12,
            color: 'inherit',
            opacity: 0.9,
            userSelect: 'none',
          },
        },
        h('span', { key: 'label', style: { whiteSpace: 'nowrap' } }, '抽帧间隔'),
        h('input', {
          key: 'range',
          type: 'range',
          min,
          max,
          step: 0.1,
          value: interval,
          onChange,
          'aria-label': '视频抽帧间隔（秒）',
          style: { width: 160, accentColor: 'currentColor', cursor: 'pointer' },
        }),
        h(
          'span',
          { key: 'value', style: { minWidth: 48, fontVariantNumeric: 'tabular-nums' } },
          `${interval.toFixed(1)}s`,
        ),
        isCustom
          ? h(
              'button',
              {
                key: 'reset',
                type: 'button',
                onClick: reset,
                title: `恢复默认 ${Number(state.configured ?? 0.5).toFixed(1)}s`,
                style: {
                  fontSize: 11,
                  padding: '1px 6px',
                  borderRadius: 4,
                  border: '1px solid currentColor',
                  background: 'transparent',
                  color: 'inherit',
                  opacity: 0.7,
                  cursor: 'pointer',
                },
              },
              '恢复默认',
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'video-eyes-interval', order: 5 },
            IntervalSlider,
          ),
        )
      },
    }
  },
})
